// gant88: Kinetic Flow's internal task planner, served at kineticflow.systems/gant88.
'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');
const { pool, migrate, seedFirstUser } = require('./db');

const BASE = '/gant88';
const PORT = Number(process.env.PORT) || 8080;
const SESSION_DAYS = 30;
const COOKIE = 'g88';
const SECURE_COOKIE = process.env.NODE_ENV === 'production';
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 12);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

// --- Security headers ---------------------------------------------------------
app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy':
      "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; " +
      "img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Robots-Tag': 'noindex, nofollow',
  });
  next();
});

// DigitalOcean can pass the /gant88 prefix through or strip it; handle both.
app.use((req, res, next) => {
  if (req.path === BASE) return res.redirect(301, BASE + '/');
  if (req.url.startsWith(BASE + '/')) req.url = req.url.slice(BASE.length);
  next();
});

app.get('/healthz', (req, res) => res.type('text').send('ok'));

app.use(express.json({ limit: '50kb' }));

// --- Sessions -------------------------------------------------------------------
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

function setSessionCookie(res, token, maxAgeSeconds) {
  const parts = [`${COOKIE}=${token}`, `Path=${BASE}`, 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`];
  if (SECURE_COOKIE) parts.push('Secure');
  res.set('Set-Cookie', parts.join('; '));
}

async function loadUser(req, res, next) {
  req.user = null;
  const token = readCookie(req, COOKIE);
  if (token && /^[A-Za-z0-9_-]{40,}$/.test(token)) {
    const { rows } = await pool.query(
      `SELECT u.id, u.email, u.name FROM gant88.sessions s JOIN gant88.users u ON u.id = s.user_id
       WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [sha256(token)]
    );
    req.user = rows[0] || null;
  }
  next();
}

function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
  next();
}

// Changes must come from our own page: a custom header can't be sent by another site's form.
function requireAppHeader(req, res, next) {
  if (req.method !== 'GET' && req.get('X-Requested-With') !== 'gant88') {
    return res.status(403).json({ error: 'Request blocked.' });
  }
  next();
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// --- Login rate limit (in memory: 10 failed tries per 15 minutes per IP) --------
const failures = new Map();
function tooManyFailures(ip) {
  const now = Date.now();
  const list = (failures.get(ip) || []).filter((t) => now - t < 15 * 60 * 1000);
  failures.set(ip, list);
  return list.length >= 10;
}
function recordFailure(ip) {
  const list = failures.get(ip) || [];
  list.push(Date.now());
  failures.set(ip, list);
}

const api = express.Router();
api.use(requireAppHeader);
api.use(wrap(loadUser));

api.post('/login', wrap(async (req, res) => {
  const ip = req.ip || 'unknown';
  if (tooManyFailures(ip)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  const { rows } = await pool.query('SELECT id, email, name, password_hash FROM gant88.users WHERE lower(email) = $1', [email]);
  const user = rows[0];
  // Compare against a dummy hash when the user is unknown, so timing doesn't reveal which emails exist.
  const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
  if (!user || !ok) {
    recordFailure(ip);
    return res.status(401).json({ error: 'Email or password not recognised.' });
  }
  const token = crypto.randomBytes(32).toString('base64url');
  await pool.query(
    `INSERT INTO gant88.sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(days => $3))`,
    [sha256(token), user.id, SESSION_DAYS]
  );
  await pool.query('UPDATE gant88.users SET last_login_at = now() WHERE id = $1', [user.id]);
  await pool.query('DELETE FROM gant88.sessions WHERE expires_at < now()');
  setSessionCookie(res, token, SESSION_DAYS * 86400);
  res.json({ user: { id: user.id, email: user.email, name: user.name } });
}));

api.post('/logout', wrap(async (req, res) => {
  const token = readCookie(req, COOKIE);
  if (token) await pool.query('DELETE FROM gant88.sessions WHERE token_hash = $1', [sha256(token)]);
  setSessionCookie(res, '', 0);
  res.json({ ok: true });
}));

api.get('/me', (req, res) => res.json({ user: req.user }));

function checkNewPassword(pw) {
  if (typeof pw !== 'string' || pw.length < 10) return 'Use at least 10 characters.';
  if (pw.length > 200) return 'That password is too long.';
  return null;
}

api.post('/password', requireUser, wrap(async (req, res) => {
  const { current, next: newPassword } = req.body;
  const problem = checkNewPassword(newPassword);
  if (problem) return res.status(400).json({ error: problem });
  const { rows } = await pool.query('SELECT password_hash FROM gant88.users WHERE id = $1', [req.user.id]);
  if (!(await bcrypt.compare(String(current || ''), rows[0].password_hash))) {
    return res.status(400).json({ error: 'Your current password is not right.' });
  }
  await pool.query('UPDATE gant88.users SET password_hash = $1 WHERE id = $2', [await bcrypt.hash(newPassword, 12), req.user.id]);
  // Sign out every other device.
  const token = readCookie(req, COOKIE);
  await pool.query('DELETE FROM gant88.sessions WHERE user_id = $1 AND token_hash <> $2', [req.user.id, sha256(token)]);
  res.json({ ok: true });
}));

api.get('/users', requireUser, wrap(async (req, res) => {
  const { rows } = await pool.query('SELECT id, email, name, last_login_at FROM gant88.users ORDER BY id');
  res.json({ users: rows });
}));

api.post('/users', requireUser, wrap(async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const name = String(req.body.name || '').trim().slice(0, 100);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  const problem = checkNewPassword(req.body.password);
  if (problem) return res.status(400).json({ error: problem });
  try {
    const { rows } = await pool.query(
      'INSERT INTO gant88.users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id, email, name',
      [email, name, await bcrypt.hash(req.body.password, 12)]
    );
    res.status(201).json({ user: rows[0] });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'That email already has an account.' });
    throw err;
  }
}));

api.delete('/users/:id', requireUser, wrap(async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: "You can't remove yourself." });
  await pool.query('DELETE FROM gant88.users WHERE id = $1', [id]);
  res.json({ ok: true });
}));

// --- Tasks ----------------------------------------------------------------------
const STATUSES = ['not_started', 'in_progress', 'blocked', 'done'];
const TASK_COLUMNS = `t.id, t.title, t.area, t.owner, to_char(t.start_date, 'YYYY-MM-DD') AS start_date,
  to_char(t.end_date, 'YYYY-MM-DD') AS end_date, t.progress, t.status, t.is_milestone, t.depends_on,
  t.notes, t.sort_order, t.updated_at, u.name AS updated_by_name, u.email AS updated_by_email`;

const isDate = (s) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));

// Validates a task body. With partial=true only the fields present are checked.
function cleanTask(body, partial) {
  const out = {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  if (!partial || has('title')) {
    const title = String(body.title || '').trim();
    if (!title || title.length > 200) return { error: 'Give the task a name (up to 200 characters).' };
    out.title = title;
  }
  for (const k of ['area', 'owner']) if (has(k)) out[k] = String(body[k] || '').trim().slice(0, 80);
  if (has('notes')) out.notes = String(body.notes || '').slice(0, 5000);
  for (const k of ['start_date', 'end_date']) {
    if (!partial || has(k)) {
      if (!isDate(body[k])) return { error: 'Dates must be real dates.' };
      out[k] = body[k];
    }
  }
  if (has('progress')) {
    const p = Math.round(Number(body.progress));
    if (!(p >= 0 && p <= 100)) return { error: 'Progress must be between 0 and 100.' };
    out.progress = p;
  }
  if (has('status')) {
    if (!STATUSES.includes(body.status)) return { error: 'Unknown status.' };
    out.status = body.status;
  }
  if (has('is_milestone')) out.is_milestone = Boolean(body.is_milestone);
  if (has('depends_on')) {
    const d = body.depends_on === null || body.depends_on === '' ? null : Number(body.depends_on);
    if (d !== null && !Number.isInteger(d)) return { error: 'Unknown task to depend on.' };
    out.depends_on = d;
  }
  return { task: out };
}

async function readTask(id) {
  const { rows } = await pool.query(
    `SELECT ${TASK_COLUMNS} FROM gant88.tasks t LEFT JOIN gant88.users u ON u.id = t.updated_by WHERE t.id = $1`, [id]);
  return rows[0];
}

api.get('/tasks', requireUser, wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT ${TASK_COLUMNS} FROM gant88.tasks t LEFT JOIN gant88.users u ON u.id = t.updated_by
     ORDER BY t.sort_order, t.start_date, t.id`);
  res.json({ tasks: rows });
}));

api.post('/tasks', requireUser, wrap(async (req, res) => {
  const { task, error } = cleanTask(req.body, false);
  if (error) return res.status(400).json({ error });
  if (task.end_date < task.start_date) return res.status(400).json({ error: 'The end date is before the start date.' });
  if (task.is_milestone) task.end_date = task.start_date;
  const cols = Object.keys(task);
  const vals = Object.values(task);
  const { rows } = await pool.query(
    `INSERT INTO gant88.tasks (${cols.join(', ')}, sort_order, created_by, updated_by)
     VALUES (${cols.map((_, i) => '$' + (i + 1)).join(', ')},
       (SELECT coalesce(max(sort_order), 0) + 1 FROM gant88.tasks), $${cols.length + 1}, $${cols.length + 1})
     RETURNING id`,
    [...vals, req.user.id]
  );
  res.status(201).json({ task: await readTask(rows[0].id) });
}));

api.patch('/tasks/:id', requireUser, wrap(async (req, res) => {
  const id = Number(req.params.id);
  const existing = await readTask(id);
  if (!existing) return res.status(404).json({ error: 'That task no longer exists.' });
  const { task, error } = cleanTask(req.body, true);
  if (error) return res.status(400).json({ error });
  const merged = { ...existing, ...task };
  if (merged.is_milestone) task.end_date = merged.end_date = merged.start_date;
  if (merged.end_date < merged.start_date) return res.status(400).json({ error: 'The end date is before the start date.' });
  if (task.depends_on === id) return res.status(400).json({ error: "A task can't depend on itself." });
  if (task.status === 'done' && !('progress' in task)) task.progress = 100;
  const cols = Object.keys(task);
  if (cols.length) {
    await pool.query(
      `UPDATE gant88.tasks SET ${cols.map((c, i) => `${c} = $${i + 1}`).join(', ')},
         updated_by = $${cols.length + 1}, updated_at = now() WHERE id = $${cols.length + 2}`,
      [...Object.values(task), req.user.id, id]
    );
  }
  res.json({ task: await readTask(id) });
}));

api.delete('/tasks/:id', requireUser, wrap(async (req, res) => {
  await pool.query('DELETE FROM gant88.tasks WHERE id = $1', [Number(req.params.id)]);
  res.json({ ok: true });
}));

api.post('/tasks/reorder', requireUser, wrap(async (req, res) => {
  const ids = Array.isArray(req.body.ids) ? req.body.ids.map(Number).filter(Number.isInteger) : [];
  if (!ids.length) return res.status(400).json({ error: 'Nothing to reorder.' });
  await pool.query(
    `UPDATE gant88.tasks t SET sort_order = o.ord FROM unnest($1::int[]) WITH ORDINALITY AS o(id, ord) WHERE t.id = o.id`,
    [ids]
  );
  res.json({ ok: true });
}));

app.use('/api', api);
app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

// --- Page -----------------------------------------------------------------------
app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: '5m' }));

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.type === 'entity.parse.failed' ? 'Bad request.' : 'Something went wrong. Please try again.' });
});

async function start() {
  await migrate();
  if (await seedFirstUser()) console.log('Created the first user from SEED_EMAIL');
  return app.listen(PORT, () => console.log(`gant88 listening on ${PORT}`));
}

if (require.main === module) {
  start().catch((err) => { console.error(err); process.exit(1); });
}

module.exports = { app, start };
