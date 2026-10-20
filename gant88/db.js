// Database connection and table setup for gant88.
// All tables live in their own schema, "gant88", so they never mix with the
// KineticFlow Lite tables in the same database.
'use strict';

const { Pool } = require('pg');

function sslConfig() {
  if (process.env.DATABASE_SSL === 'off') return false;
  // DigitalOcean provides the cluster's CA certificate as ${db.CA_CERT}.
  if (process.env.DATABASE_CA_CERT) return { ca: process.env.DATABASE_CA_CERT, rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}

function connectionString() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is not set');
  // Remove sslmode from the URL so the ssl settings above are the ones used.
  const url = new URL(raw);
  url.searchParams.delete('sslmode');
  return url.toString();
}

const pool = new Pool({
  connectionString: connectionString(),
  ssl: sslConfig(),
  max: 5,
  idleTimeoutMillis: 30000,
});

const MIGRATIONS = [
  // 1: users, sessions, tasks
  `
  CREATE SCHEMA IF NOT EXISTS gant88;

  CREATE TABLE IF NOT EXISTS gant88.users (
    id            serial PRIMARY KEY,
    email         text NOT NULL,
    name          text NOT NULL DEFAULT '',
    password_hash text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    last_login_at timestamptz
  );
  CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower ON gant88.users (lower(email));

  CREATE TABLE IF NOT EXISTS gant88.sessions (
    token_hash text PRIMARY KEY,
    user_id    integer NOT NULL REFERENCES gant88.users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL
  );
  CREATE INDEX IF NOT EXISTS sessions_user ON gant88.sessions (user_id);

  CREATE TABLE IF NOT EXISTS gant88.tasks (
    id           serial PRIMARY KEY,
    title        text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    area         text NOT NULL DEFAULT '',
    owner        text NOT NULL DEFAULT '',
    start_date   date NOT NULL,
    end_date     date NOT NULL,
    progress     integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
    status       text NOT NULL DEFAULT 'not_started'
                 CHECK (status IN ('not_started','in_progress','blocked','done')),
    is_milestone boolean NOT NULL DEFAULT false,
    depends_on   integer REFERENCES gant88.tasks(id) ON DELETE SET NULL,
    notes        text NOT NULL DEFAULT '',
    sort_order   integer NOT NULL DEFAULT 0,
    created_by   integer REFERENCES gant88.users(id) ON DELETE SET NULL,
    updated_by   integer REFERENCES gant88.users(id) ON DELETE SET NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    updated_at   timestamptz NOT NULL DEFAULT now(),
    CHECK (end_date >= start_date),
    CHECK (depends_on IS NULL OR depends_on <> id)
  );
  `,
];

async function migrate() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Stop two instances migrating at the same time.
    await client.query("SELECT pg_advisory_xact_lock(hashtext('gant88_migrate'))");
    await client.query('CREATE SCHEMA IF NOT EXISTS gant88');
    await client.query(`CREATE TABLE IF NOT EXISTS gant88.schema_version (
      version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const { rows } = await client.query('SELECT coalesce(max(version), 0) AS v FROM gant88.schema_version');
    for (let i = rows[0].v; i < MIGRATIONS.length; i++) {
      await client.query(MIGRATIONS[i]);
      await client.query('INSERT INTO gant88.schema_version (version) VALUES ($1)', [i + 1]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// Creates the first user from environment settings when the users table is empty.
// SEED_PASSWORD_HASH is a bcrypt hash (made with `npm run hash-password`), never a plain password.
async function seedFirstUser() {
  const email = (process.env.SEED_EMAIL || '').trim().toLowerCase();
  const hash = process.env.SEED_PASSWORD_HASH || '';
  if (!email || !hash) return false;
  if (!/^\$2[aby]\$\d{2}\$/.test(hash)) throw new Error('SEED_PASSWORD_HASH is not a bcrypt hash');
  const { rowCount } = await pool.query(
    `INSERT INTO gant88.users (email, name, password_hash)
     SELECT $1, $2, $3 WHERE NOT EXISTS (SELECT 1 FROM gant88.users)`,
    [email, process.env.SEED_NAME || '', hash]
  );
  return rowCount > 0;
}

module.exports = { pool, migrate, seedFirstUser };
