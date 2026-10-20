// API tests. Needs a throwaway PostgreSQL database:
//   DATABASE_URL=postgres://postgres@localhost:5433/kf DATABASE_SSL=off npm test
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');

const EMAIL = 'tester@example.com';
const PASSWORD = 'correct horse battery';
process.env.SEED_EMAIL = EMAIL;
process.env.SEED_NAME = 'Tester';
process.env.SEED_PASSWORD_HASH = bcrypt.hashSync(PASSWORD, 4);
process.env.PORT = '0';

const { pool } = require('../db');
const { start } = require('../server');

let server, base, cookie = '';

async function call(path, method = 'GET', body, extra = {}) {
  const res = await fetch(base + path, {
    method,
    redirect: 'manual',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'gant88', Cookie: cookie, ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const set = res.headers.get('set-cookie');
  if (set) cookie = set.split(';')[0];
  let data = null;
  try { data = await res.json(); } catch { /* not json */ }
  return { status: res.status, data, res };
}

test.before(async () => {
  await pool.query('DROP SCHEMA IF EXISTS gant88 CASCADE');
  server = await start();
  if (!server.listening) await require('node:events').once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => { server.close(); await pool.end(); });

test('page and redirects', async () => {
  let r = await fetch(base + '/gant88', { redirect: 'manual' });
  assert.equal(r.status, 301);
  assert.equal(r.headers.get('location'), '/gant88/');
  r = await fetch(base + '/gant88/');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /Kinetic Flow Planner/);
  assert.match(r.headers.get('x-robots-tag'), /noindex/);
  r = await fetch(base + '/gant88/app.js');
  assert.equal(r.status, 200);
});

test('signed-out requests are refused', async () => {
  assert.equal((await call('/gant88/api/tasks')).status, 401);
  assert.deepEqual((await call('/gant88/api/me')).data, { user: null });
});

test('wrong password is refused, right one signs in', async () => {
  assert.equal((await call('/gant88/api/login', 'POST', { email: EMAIL, password: 'nope' })).status, 401);
  assert.equal((await call('/gant88/api/login', 'POST', { email: 'who@x.com', password: PASSWORD })).status, 401);
  const r = await call('/gant88/api/login', 'POST', { email: 'TESTER@example.com ', password: PASSWORD });
  assert.equal(r.status, 200);
  assert.equal(r.data.user.email, EMAIL);
  assert.match(r.res.headers.get('set-cookie'), /HttpOnly; SameSite=Strict/);
  assert.match(r.res.headers.get('set-cookie'), /Path=\/gant88/);
  assert.equal((await call('/gant88/api/me')).data.user.name, 'Tester');
});

test('changes without the app header are blocked', async () => {
  const r = await call('/gant88/api/tasks', 'POST', { title: 'x' }, { 'X-Requested-With': '' });
  assert.equal(r.status, 403);
});

test('tasks: create, validate, edit, reorder, depend, delete', async () => {
  let r = await call('/gant88/api/tasks', 'POST', { title: 'Meta business verification', area: 'Meta', owner: 'Peter', start_date: '2026-10-21', end_date: '2026-10-28' });
  assert.equal(r.status, 201);
  const a = r.data.task;
  assert.equal(a.start_date, '2026-10-21');
  assert.equal(a.status, 'not_started');
  assert.equal(a.updated_by_name, 'Tester');

  assert.equal((await call('/gant88/api/tasks', 'POST', { title: '', start_date: '2026-10-21', end_date: '2026-10-22' })).status, 400);
  assert.equal((await call('/gant88/api/tasks', 'POST', { title: 'x', start_date: '2026-10-25', end_date: '2026-10-22' })).status, 400);
  assert.equal((await call('/gant88/api/tasks', 'POST', { title: 'x', start_date: 'soon', end_date: '2026-10-22' })).status, 400);

  r = await call('/gant88/api/tasks', 'POST', { title: 'App Review', area: 'Meta', start_date: '2026-10-29', end_date: '2026-11-18', depends_on: a.id });
  const b = r.data.task;
  assert.equal(b.depends_on, a.id);
  assert.equal((await call(`/gant88/api/tasks/${b.id}`, 'PATCH', { depends_on: b.id })).status, 400);

  r = await call('/gant88/api/tasks', 'POST', { title: 'Launch', start_date: '2026-12-01', end_date: '2026-12-09', is_milestone: true });
  assert.equal(r.data.task.end_date, '2026-12-01', 'milestone is a single day');

  r = await call(`/gant88/api/tasks/${a.id}`, 'PATCH', { status: 'done' });
  assert.equal(r.data.task.progress, 100);
  r = await call(`/gant88/api/tasks/${a.id}`, 'PATCH', { start_date: '2026-10-22', end_date: '2026-10-30' });
  assert.equal(r.data.task.end_date, '2026-10-30');
  assert.equal((await call(`/gant88/api/tasks/${a.id}`, 'PATCH', { end_date: '2026-10-01' })).status, 400);
  assert.equal((await call('/gant88/api/tasks/99999', 'PATCH', { title: 'x' })).status, 404);

  r = await call('/gant88/api/tasks/reorder', 'POST', { ids: [b.id, a.id] });
  assert.equal(r.status, 200);
  r = await call('/gant88/api/tasks');
  assert.equal(r.data.tasks[0].id, b.id);
  assert.equal(r.data.tasks.length, 3);

  await call(`/gant88/api/tasks/${a.id}`, 'DELETE');
  r = await call('/gant88/api/tasks');
  assert.equal(r.data.tasks.find((t) => t.id === b.id).depends_on, null, 'dependency cleared when task deleted');
});

test('team and password', async () => {
  let r = await call('/gant88/api/users', 'POST', { email: 'dev@example.com', name: 'Dev', password: 'short' });
  assert.equal(r.status, 400);
  r = await call('/gant88/api/users', 'POST', { email: 'dev@example.com', name: 'Dev', password: 'temporary-pass-1' });
  assert.equal(r.status, 201);
  assert.equal((await call('/gant88/api/users', 'POST', { email: 'DEV@example.com', password: 'temporary-pass-1' })).status, 409);
  r = await call('/gant88/api/users');
  assert.equal(r.data.users.length, 2);
  assert.ok(!('password_hash' in r.data.users[0]));

  assert.equal((await call('/gant88/api/password', 'POST', { current: 'wrong', next: 'a-new-password' })).status, 400);
  assert.equal((await call('/gant88/api/password', 'POST', { current: PASSWORD, next: 'a-new-password' })).status, 200);
  await call('/gant88/api/logout', 'POST', {});
  assert.equal((await call('/gant88/api/tasks')).status, 401);
  assert.equal((await call('/gant88/api/login', 'POST', { email: EMAIL, password: PASSWORD })).status, 401);
  assert.equal((await call('/gant88/api/login', 'POST', { email: EMAIL, password: 'a-new-password' })).status, 200);
});

test('seed user is not added twice', async () => {
  const { seedFirstUser } = require('../db');
  assert.equal(await seedFirstUser(), false);
});
