# VoltTrade Cloud — Architecture, Process and Logic Review

Scope: full read of `api/`, `src/`, `db/`, `scripts/`, `docs/`, `tests/`, `verifier/`,
CI and container definitions at commit `455d9b0` (branch `claude/architecture-review-ms3h77`).

**Verification status:** the findings below come from source reading. They have since been
confirmed against a running build. Continuous integration is now **green end to end on this
branch — all three jobs, every gate, including the browser suite and a real TimescaleDB**.
Before this work it had failed on every run since at least 13 August, for the reason in §7.1,
which turned out to be the most consequential finding in the review.

**Remediation status:** a follow-up commit on this branch fixes a large part of what follows.
See "Appendix: what has been fixed" at the end for the item-by-item status. Findings are left
written in the present tense as originally assessed, so the appendix is the authority on what
is still open.

This review answers three questions: **what is broken**, **what is missing**, and
**what should be added** for the platform to be production-grade and professional.
Findings are ordered by severity. Each carries a file reference so it can be actioned
directly.

---

## 0. Executive summary

The domain core is strong. Control safety in particular is better than most commercial
EMS products: a whitelist plus a bench/field verification gate plus range clamping plus
FC6 write with read-back, and a fail-closed state-of-charge guard with a telemetry
freshness bound. Ingest durability (write-ahead log before the batch writer) and the
device-profile-driven register mapping are both sound designs.

The weaknesses are not in the domain logic. They are in three areas:

1. **The deployment is not reproducible.** Migrations are gitignored and partly absent,
   the seed script is an empty stub, and the README is Vite boilerplate. A new engineer
   cannot stand this up from the repository alone.
2. **The documented high-availability topology is unsafe with the current code.**
   `docs/ha.md` prescribes two replicas with an MQTT shared subscription, but at least
   six pieces of correctness-critical state live in per-process memory. With two replicas
   the system silently misbehaves rather than failing loudly.
3. **Multi-tenancy is half-built.** Seven tables carry no `orgId`, several routers ignore
   org scope, and auto-provisioned devices land with `orgId` null. Notifications and audit
   records cross tenant boundaries today.

Additionally, three user-facing features are shipped but non-functional (Telegram alarms,
email alarms, the report-schedule run toast), and roughly a dozen backend procedures have
no user interface at all.

---

## 1. Critical — correctness and safety

### 1.1 Database migrations are not in the repository

`.gitignore` excludes `db/migrations/*.sql`. Only `0014`–`0019` are tracked; `0000`–`0013`
and `0020` exist in no commit. The migration journal stops at index 13. Commit `755211a`
states it added `ems_plans.min_soc/max_soc` "migration 0020" — the schema has the columns,
the migration does not exist.

Consequence: `npm run db:migrate` cannot build the schema. The Dockerfile acknowledges this
("Never rely on `db/migrations/*.sql` — those are gitignored") and works around it with a
`drizzle-kit generate` snapshot at image-build time, which means the production schema is
whatever the last image build inferred, with no reviewable diff and no down-path.

**Fix:** un-ignore `db/migrations/`, regenerate the full chain from `db/schema.ts`, commit
the journal, and make `db:migrate` the only supported schema path. Treat a schema change
without a committed migration as a CI failure.

### 1.2 High-availability state is per-process

`docs/ha.md` specifies two app replicas sharing `$share/enertrek/#`. These structures are
module-level `Map`s, so each replica holds a different view:

| State | File | Failure with 2 replicas |
|---|---|---|
| Alarm hysteresis `breachState` | `api/mqtt/handlers.ts` | Duplicate raise / missed clear; hysteresis defeated |
| C30 outstanding-read registry | `api/mqtt/c30-outstanding.ts` | Read-back verification fails when the response lands on the other replica |
| EMS `lastCmd` / `peakState` | `api/ems/controller.ts` | Idempotency window bypassed; setpoint flapping between replicas |
| Login lockout counters | `api/routers/auth.ts` | Brute-force budget multiplied by replica count |
| MFA pending challenges | `api/routers/auth.ts` | MFA step fails when the second request hits the other replica |
| User / API-key cache (30 s) | `api/middleware.ts` | Revoked user stays valid on the replica that did not evict |

Every background loop (EMS controller, alarm escalation, offline sweep, watchdog, poller)
also starts on every replica in `api/boot.ts`. Only the report scheduler takes a DB claim.

**This is the single highest-risk item in the system**, because the C30 and EMS entries mean
a *control* action can be issued twice or verified incorrectly.

**Fix:** two options, in order of preference.
- **Short term, honest:** make single-instance the only supported topology. Add a startup
  advisory-lock so a second replica refuses to start the control/ingest loops, and correct
  `docs/ha.md`.
- **Proper:** introduce Redis (or a DB-backed claim table) for `breachState`, the C30
  registry, EMS idempotency, lockout and MFA; add leader election so each background loop
  runs on exactly one replica.

### 1.3 Cross-tenant leakage in notifications, audit and profiles

Tables with no `orgId` column: `telemetry`, `telemetryHourly`, `alarms`, `deviceProfiles`,
`commands`, `sessions`, `auditLog`, `mfaBackupCodes`, `notificationChannels`,
`alarmNotifications`, `maintenanceWindows`.

Concrete consequences:

- `api/alarms/notify.ts` dispatches every alarm to **all enabled channels**, with no org
  filter. Tenant A's alarm reaches tenant B's webhook, Telegram chat and mailbox.
- `api/routers/notifications.ts` lists channels, maintenance windows and delivery history
  unscoped. Any operator sees and edits every tenant's channels.
- `auditLog` has no `orgId`, so an org-scoped audit view is impossible to build.
- `deviceProfiles` is global and `profiles.updateMap` is `operator`, not `admin`
  (`api/routers/profiles.ts`). An operator in one tenant can rewrite the register map and
  the `controllable` whitelist used by every other tenant — a control-safety boundary, not
  just a data boundary.
- `evaluateAlarmRules` in `api/mqtt/handlers.ts` ignores `rule.orgId`, so a rule with a null
  `meterId` fires across all orgs.
- `dashboard.powerTrend` (`api/routers/dashboard.ts:96`) is `authed` with no org scope,
  unlike `overview` and `recentAlarms` beside it. It sums every tenant's power.

**Fix:** add `orgId` to the eleven tables, backfill from the parent entity, route all
notification/audit/maintenance queries through the existing `api/lib/org-scope.ts` helpers,
scope `evaluateAlarmRules` by rule org, scope `powerTrend`, and move `profiles.updateMap`
to `admin` (or make profiles org-owned with a superadmin-managed global catalogue).

### 1.4 Auto-provisioned devices are invisible to their tenant

`api/mqtt/service.ts` auto-creates gateways and `ensureMeter` in `api/mqtt/handlers.ts`
auto-creates meters with `orgId` null and a PEM3000 profile fallback. Under org scoping a
null-org device is invisible to every tenant, so real hardware that connects before being
registered silently disappears from the UI while still ingesting.

**Fix:** derive the org from a broker-authenticated client identity (EMQX username or
client-certificate CN) and stamp it at provisioning time. Until that exists, route unknown
devices into an explicit "unclaimed devices" queue that a superadmin assigns, rather than
into a null-org limbo.

### 1.5 Non-timing-safe token comparison

`api/boot.ts:135` compares the bearer token with `!==`. Use `crypto.timingSafeEqual` on
equal-length buffers. Small, but it is an authentication primitive.

---

## 2. High — shipped features that do not work

### 2.1 Telegram alarm channel cannot accept a real bot token

Validation in `api/routers/notifications.ts:13` is
`/^[^:]{20,}:[^:]{3,}$/` for `botToken:chatId`. A real Telegram bot token is itself
`<digits>:<secret>`, e.g. `123456789:AAH...`. The numeric prefix is ~10 digits, so
`[^:]{20,}` never matches, and a valid `token:chat` string contains two colons.

Delivery compounds it: `api/alarms/notify.ts:39` does
`const [token, chatId] = channel.target.split(":")`, which for a real token yields
`token = "123456789"` and `chatId = "AAH..."`.

**Fix:** store `botToken` and `chatId` as separate columns/fields, validate the token as
`^\d{6,}:[A-Za-z0-9_-]{30,}$` and the chat id as `^-?\d+$`.

### 2.2 Email alarm channel always fails

`api/alarms/notify.ts:53` dynamically imports `nodemailer`, which is not a dependency in
`package.json`. Every email dispatch throws `nodemailer not installed`. The channel type is
offered in the UI as if it worked.

**Fix:** add `nodemailer` as a dependency, or remove the email channel type from the UI and
the enum until it is supported. Do not ship a selectable option that always errors.

### 2.3 Report schedules card is rendered twice

`src/pages/Reports.tsx` mounts `<ReportSchedulesCard />` at both line 90 and line 156. The
page shows two independent copies of the same list.

### 2.4 Run-schedule toast is always blank

`runSchedule` returns `filename` (`api/reports/scheduler.ts:139`). The UI reads
`r.fileName` (`src/components/ReportSchedulesCard.tsx:48`) through an `as { fileName?: string }`
cast, which suppresses the type error. The success toast interpolates an empty string.

### 2.5 Hardcoded meter models in the gateway detail page

`src/pages/GatewayDetail.tsx` hardcodes SEM2250/SEM3250/PEM3000 in its add-meter dialog,
while the Meters page is profile-driven. Adding a new profile does not make it selectable
here.

### 2.6 The browser scrapes `/metrics`

`src/pages/MeterDetail.tsx` and `src/pages/GatewayDetail.tsx` fetch the Prometheus text
endpoint from the browser and parse rejection counters out of it. `docs/ha.md` recommends
restricting `/metrics` to the scraper at the proxy — doing so breaks these pages.

**Fix:** expose the counters the UI needs as a tRPC procedure. `/metrics` is an operational
endpoint, not an application API.

### 2.7 Webhook channels allow arbitrary URLs (server-side request forgery)

`api/routers/notifications.ts` accepts any `z.string().url()` as a webhook target. The server
then POSTs to it. An operator can point a channel at `http://169.254.169.254/...` or an
internal service and read the response path through delivery status.

**Fix:** enforce https, resolve the hostname and reject private, loopback, link-local and
unique-local ranges before the request, and re-check after DNS resolution to close the
rebinding gap.

---

## 3. High — EMS and control gaps

The interlocks that exist are good. What is missing is the *continuous* half of control.

- **No deadman / keep-alive on setpoints.** If the platform dies after commanding a 500 kW
  discharge, the battery holds that setpoint indefinitely. `docs/profiles-bess.md` already
  flags vendor watchdog registers as unresolved. This is the most serious control gap:
  every serious EMS writes a watchdog register on a cycle shorter than the inverter's
  timeout so loss of the controller means automatic safe-state.
- **Peak shaving reads stale telemetry.** `api/ems/decide.ts` obtains the source value via
  `store.latest()` with no age bound, while the SoC guard correctly uses `freshForControl`.
  A frozen meter therefore produces confident peak-shaving decisions from an old reading.
  Apply the same freshness bound to every control input.
- **Schedules never auto-idle at window end.** When a schedule window closes, the last
  setpoint persists. Windows need an explicit exit action (idle / 0 kW / revert).
- **Expired plans leave the last setpoint applied.** Same class of problem in
  `api/ems/plans` handling.
- **No FC16 / multi-register write.** `api/control/execute.ts` rejects anything but FC6.
  Most BESS setpoints are 32-bit or need an enable-then-value sequence, which cannot be
  expressed. `docs/profiles-bess.md` lists this as an open design item.
- **No per-meter EMS enable/disable or emergency stop.** There is no single control to take
  one asset out of automatic control without deleting its plans.
- **No site-level grid import/export limit or curtailment.** Control is per-meter only, so
  a connection-point constraint cannot be enforced.
- **5-minute idempotency window vs. vendor watchdogs.** `EMS_IDEMPOTENCY_MS` suppresses
  repeat writes for five minutes, which conflicts with any inverter expecting a refresh
  faster than that.

---

## 4. High — alarming is too primitive for production

`evaluateAlarmRules` supports `gt`/`lt` on a single metric, with in-memory hysteresis and a
DB dedup key. Missing, in rough priority order:

1. **Duration / debounce.** No "above threshold for N minutes" condition, so a single noisy
   sample raises an alarm.
2. **Return-to-normal notification.** Clearing is recorded but not dispatched, so an operator
   who received the raise never learns it resolved.
3. **Device-offline alarms.** A gateway going offline *does* raise an alarm row
   (`api/mqtt/service.ts`), but the sweep never calls the dispatcher, so it notifies nobody. A
   meter going offline raises nothing at all — only its status flips. For a *monitoring*
   platform this is the most conspicuous omission.
4. **Severity-based routing.** All channels get everything; there is no critical-vs-warning
   routing, no per-severity escalation delay, no on-call rotation.
5. **Acknowledgement metadata.** No `acknowledgedBy`, no note, no suppression-with-reason.
6. **Rate limiting / storm control.** A flapping site can emit unbounded notifications.
7. **Composite and rate-of-change conditions**, and no deadband distinct from hysteresis.

---

## 5. Medium — security hardening

- **Session token in `localStorage` plus `x-session-token` header** (`api/context.ts`,
  `api/lib/auth.ts`). Any cross-site scripting flaw exfiltrates a full session. Prefer the
  httpOnly cookie exclusively for the browser and reserve header auth for API keys.
- **`SameSite=None; Secure; Partitioned` cookie with no CSRF defence** (`api/routers/auth.ts`).
  With `SameSite=None` a cross-site POST carries the cookie. Add an Origin/Referer check or a
  double-submit token on mutating routes.
- **No password lifecycle.** `auth.changePassword` exists on the API but has no screen, and
  there is no reset flow, no invite flow, no complexity or rotation policy, and no session
  listing or revocation. `docs/commissioning.md` instructs the commissioning engineer to use
  "Settings → Users" and change the password — neither screen exists.
- **Default `admin1234` credential** with no forced first-login change.
- **Audit log lacks IP address, user agent and `orgId`**, which is below the bar for anything
  touching energy assets. Control actions especially should record the source address.
- **Up to 30 s of validity after a user is disabled**, because the user cache is per-process
  and eviction is local (`api/middleware.ts`).
- **MQTT ingest has no payload size cap, no topic/uid validation, and unbounded concurrency.**
  `api/mqtt/service.ts` subscribes to `#` and fires `void onMessage(...)` per message.
  `uidFromAnyTopic` takes the last topic segment verbatim, so any publisher can create
  arbitrary gateway rows. Add a topic allowlist, a uid format check, a byte cap and a bounded
  work queue with backpressure.
- **No rate limiting in the application.** `api/rest/v1.ts` defers this to the proxy, so a
  direct-to-app deployment has none, including on the login route.
- **`/metrics`, `/healthz`, `/readyz` unauthenticated** in `api/boot.ts`. `/metrics` exposes
  topology and volume; at minimum bind it to a separate port or require a token.

---

## 6. Medium — data, API and operations

- **No idempotency on telemetry inserts.** No unique constraint on
  (meter, timestamp, metric), so a WAL replay after a crash duplicates rows and skews energy
  totals. Add a natural unique key and use upsert semantics.
- **TimescaleDB continuous aggregates are unused.** `api/telemetry/timescale.ts` runs
  `dailyReport` against the raw hypertable. Add continuous aggregates and query those;
  reports will otherwise degrade linearly with retention.
- **`energyTodayKwh` is UTC-only** (`api/routers/dashboard.ts`) although sites carry a
  timezone that the report scheduler already honours. "Today" is wrong for every non-UTC site.
- **No pagination anywhere.** `/api/v1/devices` and `/api/v1/alarms` cap at 500 rows with no
  cursor; UI tables render everything.
- **No OpenAPI document** for the public REST API, so there is no generated client or contract
  test.
- **Unbounded Prometheus label cardinality.** `api/lib/observability.ts` labels `http.byPath`
  with the raw path, so `/api/v1/devices/1234` creates a series per device id. Use route
  templates.
- **No structured logging and no log levels.** Diagnosing a field incident means reading
  `console.log` output.
- **Partial graceful shutdown.** The telemetry write-ahead log does drain on `SIGTERM`
  (`api/telemetry/index.ts`), which is the part that matters for data loss. The HTTP listener is
  not closed, so the process can exit underneath a request still being served.
- **Backups are application-level JSONL**, which will not scale and is not a
  point-in-time-recoverable database backup.
- **Container hygiene:** the root `Dockerfile` installs devDependencies, bundles MariaDB for
  demo mode and runs as root. Keep `Dockerfile.server` as the production path, make it
  multi-stage, production-only and non-root, and never publish the demo image to a production
  registry.
- **No Kubernetes or Helm manifests**, despite `docs/ha.md` describing a replica topology.

---

## 7. Medium — repository reproducibility and hygiene

- **7.1 — `package-lock.json` pinned 479 of its 898 tarballs to a private mirror host**
  (`https://npm.mirrors.msh.team/...`) rather than to the configured public registry. `npm ci`
  uses each recorded URL verbatim, so it stalled on every one of them from any machine outside
  that network.

  This was not a cosmetic problem. **Continuous integration had failed on every run since at
  least 13 August**, always at `npm ci`, roughly 73 seconds in, with npm's
  `Exit handler never called!`. Typecheck, lint, tests and build never executed on any commit in
  that period. A green pipeline was not being ignored — there had never been one.

  Fixed by rewriting only the host to `registry.npmjs.org`. Versions and integrity hashes are
  untouched, so npm still verifies every downloaded tarball against the hash the mirror's copy
  produced.

  **Was the mirror deliberate?** The evidence says no. A mirror used as a supply-chain control
  is pinned in a committed `.npmrc` so that every developer and every CI run resolves through
  it; this repository tracks no `.npmrc`, and the host appears nowhere outside the lockfile —
  not in the workflow, the Dockerfiles, the compose files or the documentation. The URLs
  arrived in the initial commit, which is what a lockfile generated on one machine looks like.
  Nothing was ever configured to reach that host from CI, and CI never did. Treat it as an
  artefact of the machine the project was scaffolded on. A CI guard now fails the build if
  non-public hosts reappear.
- `db/seed.ts` is an empty TODO template, so there is no supported way to bootstrap a first
  admin outside the demo Docker path.
- `README.md` is the Vite starter template with operations notes prepended. No setup steps, no
  environment table, no architecture overview, no runbook entry point.
- `package.json` is still `name: "my-app"`, version `0.0.0`.
- `src/App.css` is Vite boilerplate; `info.md` is a sandbox leftover.
- `CONTROL_TELEMETRY_MAX_AGE_MS` is read by `api/lib/env.ts` but absent from `.env.example`.
  A safety-relevant variable must be documented.
- `scripts/watchdog.sh` and several probes hardcode `/mnt/agents/output/...`;
  `verifier/probe-v9-e2e-integration.ts` imports from `../../../work/volttrade-erp/...`, a path
  outside the repository.
- `verifier/probe-gw5-verify.ts` calls `profiles.remove`, a procedure that does not exist.
- `tests/e2e/login.spec.ts` asserts the heading "Enertrek Cloud"; the app renders "VoltTrade
  Cloud" (`src/pages/Login.tsx`). The suite is manual-only in CI, so this has gone unnoticed.
- The `npm audit` allowlist in `.github/workflows/ci.yml` still references `xlsx` advisories
  although `exceljs` replaced it. Stale suppressions hide new findings.
- `npm run lint` was not part of CI, and the ESLint configuration was the unmodified Vite
  starter: browser globals and both React plugins applied to every TypeScript file, including
  the Node server, the Drizzle schema and the operator scripts. Enabling lint against that
  config produced 55 errors, most of them React rules fired at server code.
- Coverage thresholds are 39/37/28/22 percent. That is a floor, not a standard; raise it
  incrementally with a ratchet.

---

## 8. Missing user interface for existing backend capability

These procedures are implemented and reachable but have no screen. The gap makes the product
feel unfinished even though the backend is not.

| Capability | Backend | UI |
|---|---|---|
| User management | `auth.users`, `createUser`, `updateUser` | none |
| Change password | `auth.changePassword` | none |
| Audit log viewer | `auth.auditLog` | none |
| Maintenance windows | `notifications.maintenance`, `createMaintenance` | none |
| Notification delivery history | `notifications.deliveries` | none |
| Modbus poller status | `poller.status` | none |
| Site edit / delete | `sites.update`, `sites.remove` | none |
| Gateway edit | `gateways.update` | none |
| Profile delete | — | none (probe expects `profiles.remove`) |

Also missing on the front end:

- **No responsive or mobile layout.** `src/components/Layout.tsx` uses a fixed 240 px sidebar
  and `src/hooks/use-mobile.ts` is written but never imported. Field commissioning happens on
  a phone or tablet.
- **No dark mode**, although `src/components/ui/sonner.tsx` imports `next-themes` with no
  provider mounted.
- `window.confirm` is used for destructive actions instead of the available `AlertDialog`.
- No 404 route, no global search, no table pagination or column sorting, no empty-state or
  error-boundary treatment.

---

## 9. Recommended new functions

Beyond fixing the above, these are the features a professional product in this category is
expected to have.

**Control and energy**
1. Setpoint deadman/watchdog with automatic safe-state on controller loss.
2. Site-level grid import/export limit with curtailment and priority ordering.
3. Tariff-aware optimisation: time-of-use and price-signal-driven charge/discharge scheduling.
4. Command dry-run / simulation mode and a per-asset emergency stop.
5. Battery state-of-health tracking and cycle counting.

**Monitoring and operations**
6. Device-offline alarms with escalation (the single highest-value alarming addition).
7. Data-quality monitoring: gap detection, stuck-value detection, backfill on reconnect.
8. Alarm suppression windows with reason, plus an on-call schedule.
9. Firmware/OTA rollout management on top of the existing `otaJobs` table.
10. A commissioning wizard mirroring `docs/commissioning.md`, so the documented process has a
    guided screen.

**Platform**
11. Org/tenant administration: invites, roles per org, org switching for superadmins.
12. Single sign-on (OIDC/SAML) — a hard requirement for industrial customers.
13. Public API keys with per-scope rate limits and a published OpenAPI document.
14. Data export and retention policy per org, plus a deletion path for privacy compliance.
15. Webhook subscriptions for outbound events (alarm raised/cleared, command executed), with
    signed payloads and retry.

---

## 10. Suggested sequencing

**Phase 1 — make it trustworthy (blocking for any production deployment)**
Commit the migrations; decide and enforce the replica topology (§1.2); add `orgId` to the
eleven tables and scope notifications, audit and profiles; fix the null-org provisioning path;
timing-safe token compare.

**Phase 2 — make it work as advertised**
Telegram and email channels; the two Reports bugs; profile-driven model picker; move the
metrics counters behind tRPC; webhook egress allowlist; telemetry idempotency key.

**Phase 3 — make it safe to operate**
Setpoint watchdog; freshness bound on every control input; schedule/plan exit actions; offline
alarms; alarm duration and return-to-normal; audit IP and org; password lifecycle and CSRF.

**Phase 4 — make it professional**
The missing screens; responsive layout; OpenAPI and pagination; continuous aggregates;
structured logging and graceful shutdown; production container and Helm chart; README, seed and
runbook; lint in CI and a coverage ratchet.

---

## 11. What is already good

Worth stating plainly, because the review above is necessarily negative:

- The control safety chain (whitelist → verification state → range clamp → FC6 write →
  read-back → audit) is genuinely well designed, and the move to a fail-closed SoC guard in
  commit `755211a` was the right call.
- Write-ahead logging ahead of the batch writer gives real durability across restarts.
- The device-profile register-map abstraction is the correct way to onboard heterogeneous
  meters and inverters, and the bench-verification workflow before field control is a mature
  practice.
- `api/lib/org-scope.ts` is a clean helper design; the problem is coverage, not the approach.
- Documentation (`docs/ha.md`, `architecture.md`, `commissioning.md`, `profiles-bess.md`) and
  the `verifier/` probe suite are unusually thorough, and `profiles-bess.md` already names
  several of the open design items independently.

---

## Appendix: what has been fixed

A follow-up commit on this branch addresses the items below. Everything not listed here is
still open, and the phased plan in §10 remains the intended order of work.

### Fixed

| § | Item | How |
| --- | --- | --- |
| 1.1 | Migrations unreproducible | `db/migrations/*.sql` un-ignored; the absent `0020` re-created from the schema; new `0021` for the tenancy columns; `scripts/apply-migrations.ts` applies pending files in order, exactly once, with a checksum recorded in `schema_migrations` and a refusal when an applied migration is edited |
| 1.3 | Cross-tenant notification leakage | `orgId` added to `notification_channels`, `maintenance_windows`, `alarm_notifications` and `audit_log`; dispatch now selects only the alarm's own org plus global channels |
| 1.3 | Unscoped notification management | Channels, maintenance windows and delivery history are listed and mutated per org; only a superadmin may create or change a global (NULL-org) row |
| 1.3 | Cross-org alarm rules | `evaluateAlarmRules` skips a rule whose org differs from the meter's |
| 1.3 | Unscoped `dashboard.powerTrend` | Scoped to the caller's meters; other tenants' power no longer contributes |
| 1.3 | Operators could rewrite global register maps | `profiles.updateMap` raised from `operator` to `admin`, matching `updateVerification` |
| 1.3 | Audit log not per-tenant | `auth.auditLog` filtered by org; rows now record `orgId`, source IP and user agent |
| 1.5 | Non-timing-safe token compare | Constant-time digest comparison in `api/boot.ts` |
| 2.1 | Telegram channel unusable | Target parsed at the LAST colon, with proper bot-token and chat-id validation shared between the router and the dispatcher |
| 2.2 | Email channel always failed | Alarm email routed through the existing `api/lib/mailer.ts`, which supports `SMTP_URL` and discrete `SMTP_HOST` settings; a log-only send is recorded as failed unless `EMAIL_TRANSPORT=log` was asked for |
| 2.3 | Duplicate schedules card | Removed the second mount in `src/pages/Reports.tsx` |
| 2.4 | Blank run-schedule toast | Reads `filename`; the cast that hid the mismatch is gone |
| 2.5 | Hardcoded meter models | The gateway page's model picker is profile-driven, like the devices page |
| 2.6 | Browser scraped `/metrics` | New `diagnostics` router serves the rejection and undecodable-frame counters; no page fetches `/metrics` any more |
| 2.7 | Webhook server-side request forgery | `api/lib/egress.ts` enforces https and blocks private, loopback, link-local, carrier-grade-NAT and multicast targets, at both save time and send time, with `WEBHOOK_ALLOW_PRIVATE` as the on-premise opt-out |
| 3 | Peak shaving ran on stale telemetry | Uses the same `freshForControl` bound as the state-of-charge guard, and fails closed: a running shave whose source goes stale is cut to idle, and a shave never starts on stale data |
| 7 | Empty seed stub | `db/seed.ts` runs the admin and device-profile seeds in order, idempotently |
| 7 | Boilerplate README | Replaced with a real one: architecture, requirements, quick start, database setup, environment table, scripts. The operational notes are kept |
| 7 | Package identity | `volttrade-cloud` 1.0.0 with a description, in both `package.json` and the lockfile |
| 7 | Undocumented env vars | `CONTROL_TELEMETRY_MAX_AGE_MS`, `WEBHOOK_ALLOW_PRIVATE` and the optional `nodemailer` requirement documented in `.env.example` |
| 7 | Sandbox-specific paths | `scripts/watchdog.sh` and the two probes derive their paths from the repository root or an env override |
| 7 | Probe called a missing procedure | `profiles.remove` added as an admin procedure that refuses while any device still uses the model |
| 7 | Stale end-to-end assertions | The login spec expects "VoltTrade Cloud" |
| 7 | Stale audit suppressions | The xlsx advisory allowlist is empty; the gate also no longer treats an advisory with no URL as allowed |
| 7 | Continuous integration had never passed | The lockfile's private-mirror URLs were rewritten to the public registry. Install now succeeds in about 13 seconds, and typecheck, lint, tests and build run for the first time |
| 7 | Lint not enforced, on a config that did not fit the codebase | ESLint now describes the three kinds of code here (Node server and tooling, React frontend, Playwright specs) instead of applying browser and React rules to everything. Vendored shadcn primitives are ignored. All 55 errors the first enforced run reported are resolved |
| 7 | Audit gate suppressed advisories for a package no longer present | The allowlist is empty. The blocking gate runs over runtime dependencies only, and a second non-blocking step reports build-time advisories so they stay visible |
| 7 | Leftover template files | `info.md` and the unused `src/App.css` removed |
| 4 | Offline alarms notified nobody | The sweep now dispatches the gateway-offline alarm it was already raising |
| 4 | Meters going offline raised nothing | A `meterOffline` alarm is raised against the same unique dedup key and cleared when the device reports again |
| 4 | No return-to-normal notification | `alarm_notifications.kind` gains "resolved" (migration 0022). It goes only to the channels that were actually notified about that alarm; manual resolution stays silent |
| 6 | No pagination on the public API | `/devices` and `/alarms` accept `limit` and `cursor` and return `nextCursor`. Opt-in, so an existing client's response is unchanged. Keyset rather than offset, and the alarm cursor carries timestamp **and** id because one sweep raises many alarms sharing a timestamp |
| 3 | No setpoint deadman | `device_profiles.watchdog` (migration 0023) plus a refresh pass at the end of each EMS tick. Off unless a profile declares it. Goes through `executeControl`, so the whitelist, verification gate, range clamp and read-back all still apply, and not through `executeAndLog`, so a refresh every few seconds does not bury the audit trail. A configured interval too close to the device timeout is tightened rather than trusted, and a controller tick too slow to serve it is reported loudly |
| 7 | Two high and two moderate advisories | `hono` 4.13.7 and `mysql2` 3.24.4 raised past their advisories; `browserslist` and `js-yaml` pinned through npm `overrides`. The musl metadata npm dropped in the process was restored by hand, because both images are Alpine and that field selects the musl binaries |
| 7 | The Playwright job could never pass | It expected a `DATABASE_URL` secret pointing at a TiDB behind Aliyun PrivateLink, unroutable from a hosted runner, so the three login specs could never sign in. The job now brings its own `mysql:8`, builds the schema from `db/schema.ts` and seeds the two accounts the specs use. No secrets. All four specs pass |
| 7 | The private mirror could come back silently | A CI step fails, before the install, if any tarball resolves from a non-public host. Verified both ways |
| 6 | HTTP listener not closed on shutdown | The listener stops accepting connections on `SIGTERM`/`SIGINT` while in-flight requests finish. The write-ahead log already drained |

| 1.2 | Login lockout counted per replica | `login_attempts` in the database. Five attempts was five **per replica**, so the brute-force budget scaled with the fleet — the opposite of what a limit is for |
| 1.2 | Pending MFA challenge was process-local | `mfa_pending` in the database. A challenge issued by one replica did not exist on the other, so a correct second factor was rejected whenever the load balancer moved the request. The store interface became async and single use now rests on the DELETE affecting exactly one row |
| 1.2 | Alarm hysteresis was process-local | `alarm_breach_state` in the database. MQTT ingestion is deliberately not leased, so both replicas evaluate the same rules; with separate hysteresis a breach could be raised twice or a clear missed entirely, and every restart forgot how long a condition had been running. Each keeps a per-replica cache in front and writes only transitions, so the ingest hot path still does not touch the database per sample |
| 1.4 | Null-org devices were invisible to everyone | `orgs.unclaimedDevices` / `claimGateway` / `claimDevice` plus a superadmin screen. The full fix still needs a broker-authenticated client identity; this makes the limbo visible and gives one action that ends it, instead of hardware ingesting into a database nobody can see |
| 4 | No alarm duration or debounce | `alarm_rules.duration_sec`, default 0 so every existing rule behaves exactly as before. The decision is a pure function (`api/alarms/hysteresis.ts`): a spike shorter than the duration wakes nobody and leaves no state behind, the clock restarts after a gap so flapping never accumulates, and state recovered from an open alarm row after a restart does not raise twice. Only possible now because the first-breach instant is durable |
| 6 | Timescale reports stopped at the raw cutoff | 001 drops raw telemetry after 90 days, so a Timescale deployment returned an **empty** report past that while MySQL returned rolled-up data — one API, two answers. Migration 002 recreates the hourly continuous aggregate with the first/last/min/max counters the report math needs, and `dailyReport`/`energyIntervals` split at the cutoff and merge, exactly as the MySQL store does |
| 6 | `telemetry_daily`'s refresh policy had never installed | Found by the new CI job the first time the SQL met a real database: with 1-day buckets, a 2-day start offset minus a 1-hour end offset is 1.96 buckets, and TimescaleDB rejects the policy. The aggregate was never refreshed on any deployment that ran the file. Nothing had noticed because nothing read it and no test applied the SQL |
| 6 | Nothing verified the Timescale SQL | A CI job brings up a TimescaleDB service container, applies both files and asserts the aggregate and the raw window function produce the same report — over a fixture with a counter reset inside one hour and another across an hour boundary |
| 8 | Nine procedures with no screen | Users, audit log, unclaimed devices, Modbus poller status, maintenance windows, notification delivery history, change password, site edit/delete and gateway edit. A new `/admin` page holds the first four; the rest join the Settings tabs and the gateways page |
| 8 | No responsive layout | The 240 px sidebar was fixed, so below roughly 1000 px content was squeezed behind it. It now collapses into a drawer and the header carries the section name. `use-mobile.ts` stays unused on purpose — the breakpoint is CSS, so nothing needs to re-render on resize |
| 8 | `window.confirm` for destructive actions | Replaced with `AlertDialog`. It matters most for a setpoint write: after the first `window.confirm`, browsers offer "prevent this page from creating more dialogs", and ticking it sends every later write to the plant with no confirmation at all |
| 8 | No 404 route | An unknown path rendered the dashboard, so a broken link looked like a working page |
| 8 | Profile delete had no caller | `profiles.remove` existed only because the probe expected it, so a profile imported by mistake stayed in the model picker forever. The server still refuses while any device uses the model |
| 8 | A render error blanked the whole app | An error boundary around the routes keeps the shell, shows the message and resets on navigation. On a monitoring product a white page is indistinguishable from the server being down |
| 8 | Toasts followed the OS theme, the app did not | `next-themes` is imported by the toaster with no provider mounted, so `useTheme` fell back to "system" and a dark desktop got dark toasts over a light-only application. Pinned to light until the product has a dark palette |

### Deliberately not changed

- **§1.2, high-availability state — mostly closed, without Redis.** The loops that command plant
  (EMS tick, OTA dispatch, Modbus poller) now hold a single-writer lease in the database, so
  exactly one replica acts and a dead holder hands over after ~90 s. That removes the risk from
  four of the six structures: EMS `lastCmd` and `peakState` and the C30 outstanding-read
  registry are only consulted by the replica that owns control, and the poller can no longer
  double-write telemetry.

  The other three — alarm hysteresis, the login lockout and the pending MFA challenge — have
  since moved into the database as well (see the table above), so no correctness-critical state
  remains in per-process memory.
- **§1.4, null-org auto-provisioning — half closed.** The queue and the claim action exist. The
  remaining half derives the tenant from a broker-authenticated client identity at provisioning
  time, so no device ever lands in limbo; that requires broker configuration this repository
  cannot make on its own.
- **Charts past the retention cutoff.** `history` and `powerTrend` still read raw rows only, so
  a chart older than 90 days is empty — on **both** stores, unchanged by this work. Closing it
  means aggregating the open `values_json` key space (a BESS chart follows `batteryPowerKw`,
  which is not a column), which is a larger change than the report path needed.
- **Advisories: 16 down to 11, and no high ones left.** Measured on the runner before and after:
  16 (1 low, 13 moderate, 2 high) became 11 (1 low, 10 moderate, 0 high). Of the eleven, exactly
  one is in a package that ships — `uuid` below 11.1.1, reached through `exceljs`. It is the one
  npm cannot resolve without a breaking change: its suggested fix downgrades `exceljs` from 4.x
  to 3.4.0, which is not a trade worth making for a missing bounds check in a code path the
  report generator does not use. Revisit when exceljs ships a newer `uuid`. The remaining ten are
  build tooling (vitest, esbuild via drizzle-kit, postcss) and are reported but do not block.
- **Dark mode.** Not shipped rather than half-shipped: every page hardcodes light
  slate/white classes, so mounting a theme provider without a dark palette would produce
  unreadable screens. The visible symptom — dark toasts over a light app — is fixed above.
- **Global search, table sorting and offset pagination in the UI.** The lists that grow
  without bound (alarms, devices) already have filters, and the REST API is keyset-paginated;
  these are UX work rather than defects.
- **§9, the recommended new functions.** Still open by design: those are the roadmap, not
  repairs. Two of them landed on the way — the setpoint deadman (§9.1) and device-offline
  alarming (§9.6) — because both were closing a safety gap rather than adding a feature.
