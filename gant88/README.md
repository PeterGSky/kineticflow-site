# Kinetic Flow Planner (gant88)

A small, login-protected Gantt chart for Kinetic Flow's own to-do list, served at
**kineticflow.systems/gant88**. It's a Node service that runs beside the static website in the
same DigitalOcean app. Search engines are told not to index it.

## What it does

- Tasks with an area, owner, start and end dates, status, progress, notes, and an optional "waits for" task.
- Milestones (single-date diamonds), overdue tasks outlined in red, a red line for today.
- Drag a bar to move it; drag either end to change its dates. Click a task to edit it.
- Day, week and month zoom; filter by owner; group by area; hide finished tasks.
- Team screen to add or remove people; everyone can change their own password.

## Database

Tables live in their own schema, `gant88`, in the existing `kineticflow-db` PostgreSQL cluster, so they
never touch the KineticFlow Lite tables. They are created automatically on start-up:

| Table | Holds |
| --- | --- |
| `gant88.users` | Email, name, bcrypt password hash, last sign-in |
| `gant88.sessions` | Hashed session tokens (30 days) |
| `gant88.tasks` | The tasks |
| `gant88.schema_version` | Which table changes have been applied |

## Settings (environment variables)

| Name | Value |
| --- | --- |
| `DATABASE_URL` | `${kineticflow-db.DATABASE_URL}` |
| `DATABASE_CA_CERT` | `${kineticflow-db.CA_CERT}` |
| `NODE_ENV` | `production` (makes the cookie HTTPS-only) |
| `SEED_EMAIL` | First user's email, created only when there are no users yet |
| `SEED_NAME` | First user's name |
| `SEED_PASSWORD_HASH` | bcrypt hash of the first password, made with `npm run hash-password`. Store as a **secret**. Never put a plain password here. |

Once the first user exists, the `SEED_*` settings are ignored and can be removed.

## DigitalOcean App Platform component

Added to the website's app as a service:

```yaml
services:
  - name: planner
    source_dir: gant88
    github: { repo: PeterGSky/kineticflow-site, branch: main, deploy_on_push: true }
    environment_slug: node-js
    build_command: npm ci --omit=dev
    run_command: npm start
    http_port: 8080
    instance_size_slug: apps-s-1vcpu-0.5gb
    instance_count: 1
    health_check: { http_path: /healthz }
    routes:
      - path: /gant88
        preserve_path_prefix: true
```

## Running it locally

```sh
cd gant88
npm install
DATABASE_URL=postgres://postgres@localhost:5432/kf DATABASE_SSL=off \
SEED_EMAIL=you@example.com SEED_PASSWORD_HASH="$(npm run -s hash-password)" npm start
# open http://localhost:8080/gant88/
```

Tests need a throwaway database (they drop and recreate the `gant88` schema):

```sh
DATABASE_URL=postgres://postgres@localhost:5432/kf_test DATABASE_SSL=off npm test
```
