# VoltTrade Cloud

IoT energy-gateway monitoring and BESS/EMS control platform. It ingests
telemetry from energy meters, PV inverters and battery systems, raises and
escalates alarms, generates scheduled reports, and drives battery setpoints
under an explicit chain of control-safety interlocks.

## Architecture at a glance

- **Frontend** — Vite + React 19, tRPC client, Tailwind, i18n (English +
  Macedonian).
- **API** — Hono + tRPC 11, role-based access control (admin / operator /
  viewer / superadmin), cookie sessions with optional TOTP multi-factor, and
  API keys with scopes for the public REST surface under `/api/v1`.
- **Storage** — Drizzle ORM over MySQL/TiDB, with an optional TimescaleDB
  telemetry store. Ingest goes through a write-ahead log before the batch
  writer, so a crash does not lose the in-flight batch.
- **Ingest paths** — three, all converging on the same persist path:
  G30 JSON over MQTT, C30 transparent Modbus RTU over MQTT (with
  outstanding-read correlation), and direct Modbus TCP polling.
- **Control** — writes are gated by a per-profile whitelist, a
  draft/bench-verified/field-verified state, range clamping, and a read-back
  check. The EMS controller layers peak shaving over plans over schedules,
  with a fail-closed state-of-charge guard.

Deeper documents live in `docs/`: `architecture.md`, `ha.md`,
`commissioning.md`, `profiles-bess.md`, `runbook-backup-dr.md`. A
severity-ordered review of known gaps is in `ARCHITECTURE_REVIEW.md`.

## Requirements

- Node.js 22
- MySQL 8 or TiDB (the `DATABASE_URL` target)
- An MQTT broker (EMQX in production; `npm run broker` starts a local aedes
  broker for development)

## Quick start (development)

```bash
npm ci
cp .env.example .env          # then fill in DATABASE_URL at minimum
npm run db:push               # create the schema in an EMPTY database
npx tsx db/seed.ts            # bootstrap admin user + device profile library
npm run broker &              # local MQTT broker
npm run simulator &           # synthetic device traffic (optional)
npm run dev                   # http://localhost:5173
```

The seed prints the bootstrap admin address and a default password. Change it
immediately after the first login.

## Try it without a database

The root `Dockerfile` builds an all-in-one demo image that boots an embedded
MariaDB, an MQTT broker, device simulators and a demo seed:

```bash
docker build -t volttrade-demo .
docker run -p 3000:3000 volttrade-demo
```

Production uses `Dockerfile.server` against an external `DATABASE_URL`; the
demo image is not a production artifact.

## Database setup

Two distinct paths — do not mix them:

- **A brand-new database** gets the full schema from `db/schema.ts`, via
  `npm run db:push` (development) or the generated snapshot the demo image
  builds with `drizzle-kit generate`.
- **An existing database** gets incremental changes from `db/migrations/*.sql`,
  applied in filename order by:

  ```bash
  npx tsx scripts/apply-migrations.ts --dry-run   # list what is pending
  npx tsx scripts/apply-migrations.ts             # apply it
  ```

  The runner records each file with a checksum in a `schema_migrations` table,
  applies each one exactly once, and refuses to continue if an already-applied
  migration has been edited. Write a NEW migration instead of changing an
  applied one.

`drizzle-kit migrate` is not the supported path: its journal
(`db/migrations/meta/_journal.json`) stops at index 13, while every migration
from 0014 on is hand-written SQL that the journal does not describe.

Timescale schema changes go in `db/timescale/001_init.sql`, which is
idempotent.

## Environment variables

`.env.example` is the reference and documents every variable inline. The ones
that change behaviour most:

| Variable | Effect |
| --- | --- |
| `DATABASE_URL` | Required. MySQL/TiDB connection string. |
| `AUTH_REQUIRED=false` | Open demo mode: no access control. Refuses to boot when `NODE_ENV=production`. |
| `API_TOKEN` | Bearer guard on `/api/trpc/*`. |
| `CONTROL_TELEMETRY_MAX_AGE_MS` | Safety. Maximum age of a telemetry sample that may inform a control decision (default 120000). |
| `MFA_ENCRYPTION_KEY` | 32 bytes of hex. Encrypts TOTP secrets at rest. |
| `SENTRY_DSN` | Background-task failure alerts. Unset means nobody is alerted. |
| `WEBHOOK_ALLOW_PRIVATE` | Permits webhook channels to reach private addresses. Off by default. |

## Scripts

| Command | Purpose |
| --- | --- |
| `npm run dev` | Vite dev server with the API mounted |
| `npm run build` | Frontend bundle plus the bundled API entry point |
| `npm start` | Run the built server |
| `npm run check` | TypeScript project build (`tsc -b`) |
| `npm run lint` | ESLint |
| `npm test` | Vitest unit tests |
| `npm run test:coverage` | Vitest with coverage thresholds |
| `npm run test:e2e` | Playwright end-to-end tests |
| `npm run broker` / `npm run simulator` | Local MQTT broker and device simulator |

Continuous integration runs typecheck, lint, unit tests with coverage
thresholds, the build, and an npm audit gate that hard-fails on any
high or critical advisory.

## Operational notes

- **Schema changes:** edit `db/schema.ts` first — it is the source of truth —
  then add a matching `db/migrations/NNNN_name.sql` and apply it with
  `npx tsx scripts/apply-migrations.ts` (see "Database setup" above). Both the
  model change and the migration must land in the same commit; a schema change
  without a committed migration leaves deployed databases with no upgrade path.
- **Tests (v5 #23):** `npm test` (vitest, `tests/`) — codec offset/stride,
  CSV formula-injection guard, poller backoff/transport classification,
  offline thresholds, G30 unit-hint normalization. E2E harnesses:
  `npx tsx scripts/test-esmu-e2e.ts`, `scripts/test-pv-e2e.ts`.
- **Destructive scripts** (`cleanup-*`, `clear-telemetry`, `repair-orphans`)
  refuse to run against a non-local `DATABASE_URL` unless `ALLOW_UNSAFE_PROD=1`
  is set (v5 #22).
- **Optional hardening env:** `API_TOKEN` (Bearer guard on /api/trpc/*) +
  `VITE_API_TOKEN` (frontend — **DEPRECATED**, will be removed in v11; use
  session login instead), `MQTT_USERNAME`/`MQTT_PASSWORD` (broker auth),
  `MQTT_BIND_HOST`, `MQTT_AUTO_PROVISION=0` (disable zero-touch onboarding).
- **MFA (audit #23):** per-user opt-in TOTP (RFC 6238, otplib) with 8
  single-use backup codes. TOTP secrets are AES-256-GCM encrypted at rest —
  set `MFA_ENCRYPTION_KEY` (64 hex chars / 32 bytes, e.g.
  `openssl rand -hex 32`). Fallback: a key is derived from `SESSION_SECRET`;
  if neither is set, MFA procedures return "MFA not configured on server" and
  logins fall back to password-only.
- **Day/timezone policy (v5 #8):** all server-side "day" bucketing is UTC
  (epoch-based); the browser renders in its local tz. One conversion point.
- **Error reporting (audit wave 4):** set `SENTRY_DSN` to push background-task
  failures (EMS tick, poller loop, report scheduler, unhandled rejections) to
  Sentry. The reporter (`api/lib/error-reporting.ts`) speaks the Sentry HTTP
  store API directly — no SDK — with 60s fingerprint dedupe; uncaught
  exceptions are reported, then the process exits for the watchdog to restart.
  **Leaving `SENTRY_DSN` unset means nobody is alerted when a background task
  fails** — errors degrade to `console.error` in the process log only.
