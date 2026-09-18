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

| 1.4 | Devices had no tenant at provisioning time | The other half of the null-org fix, without touching the broker: a pre-registered UID stamps the gateway on first publish, `MQTT_DEFAULT_ORG_ID` covers a single-tenant installation, and anything unregistered still lands in the queue. Also fixed a second case the queue could not see — an auto-provisioned METER was NULL-org even under a gateway that had an owner, so it was invisible to the tenant whose uplink it arrived on |
| 6 | Charts stopped at the retention cutoff | `history()` splits at the cutoff and merges, like the reports already did. The hourly rollups gain voltage, current, frequency, battery power and irradiance (0027, timescale/003) — the last two are the PRIMARY_POWER_KEY of BESS and weather devices and live in values_json, so without them those charts went flat while a meter's did not |
| 6 | The aggregate half of a split range overlapped the raw half | Found by the new chart test, and older than this branch: every split read the cutoff's OWN hour from both sources, so reports and settlement intervals had been double-counting it — samples inflated, weighted averages leaning toward the tail. `aggregateUpperBound()` stops the aggregate before that hour; raw serves it, which is exactly the source that still holds it |
| 7 | `uuid` advisory in a shipping package | Pinned past GHSA-w5hq-g745-h8pq by override. exceljs still depends on uuid ^8 upstream and uses only `{v4}`, so ^11.1.1 — the last line with a CJS require condition — closes it without npm's proposed downgrade of exceljs to 3.4.0. No high or moderate advisory now reaches a runtime package |
| 8 | No dark mode | The `.dark` palette had been in index.css since scaffolding and next-themes was already a dependency; what was missing was a provider, a toggle, and pages that read the tokens instead of hardcoding light greys. ~260 classes across 37 files moved onto the token layer. The sidebar was hand-edited, not swept — that rail is deliberately dark in BOTH themes. Chart grids and axes follow the theme through currentColor |
| 9.2 | No grid connection limit | A connection agreement caps import and, more often the binding one, export; breaching it is contractual and often regulatory. Per-site limits with a curtailment order that is obeyed rather than averaged, running FIRST in the EMS tick — ahead of peak shaving, plans and schedules, because it is the only one of the four that is an obligation rather than an optimisation. Writes go through `activePowerLimitPct`, so the existing whitelist, verification gate, range clamp and read-back all still apply |
| 9.2 | — closed loop, not a formula | Curtailing changes the measurement that asked for it, so recomputing a target from each reading would oscillate: curtail hard, watch export collapse, release fully, breach again. The controller holds a total and nudges it — up by the overshoot, down by the headroom, both capped per tick — with a deadband so it stops hunting at the limit. The total is persisted, because a restart that released a whole site at once is exactly the failure this feature exists to prevent |
| 9.2 | — which way "fail closed" runs here | A stale metering point HOLDS the curtailment rather than releasing it: releasing is the action that breaches the agreement, and there is no measurement saying it is safe. Curtailing further would be inventing a breach from no data and costing generation for nothing |
| 9.4 | No way to say "stop touching this device" | Five things now command plant on their own — the grid limit, peak shaving, plans, schedules and the watchdog — and the only lever was disabling each feature one at a time and hoping none was missed, which is not what you want to be doing beside an inverter with the covers off. A per-device emergency stop refuses every write, enforced inside `executeControl`: the single chokepoint all five pass through, so a controller added later inherits it instead of having to remember it. Read from the database, not the cached meter row — a stop that takes effect in five minutes is not a stop |
| 9.4 | — order is the whole feature | Engaging drives the device to zero FIRST and locks SECOND, because the lock refuses every write including that one. A safe-state write that fails does not prevent the lock: a device that cannot be reached is exactly when the stop matters most |
| 9.4 | Setpoints could only be tried by sending them | A dry run reports what a write would do — whitelist, verification gate, clamped value, target register, and whether the device is stopped — through the same function as the real path, stopping before the bus. A rehearsal running different code from the performance would be worth less than none. Previews never reach the commands table: that is the record of what went to plant, and an incident review must not find rehearsals mixed into it |
| 9.7 | Nothing detected a frozen register | A stuck sensor returns the SAME plausible number forever: the device stays online, every gt/lt rule sees a value inside its limits, nothing fires, and that number goes on feeding EMS decisions and billing. A new `stuck` rule operator reads `threshold` as seconds-unchanged and reuses the existing dedup, hysteresis, duration, maintenance-window and notification machinery. Exact equality, not a tolerance band — a live sensor jitters in its last digits, so a band would call a genuinely steady 50.00 Hz supply stuck |
| 9.7 | Reports could not say how complete they were | Each day now carries `coverage`: its sample count over the median of the device's other days. A day the gateway spent mostly offline used to look like a normal day with a smaller total, and got invoiced. Calibrated from the report itself, so there is no nominal sample interval to configure and it works the same for a pushing MQTT device and a polled Modbus one |
| 9.8 | Alarms could only be silenced by the siteful | A maintenance window blanks a whole site and stops the alarm being RAISED at all. The case that actually comes up is narrower — one rule, or one device, is known-broken and should stop paging people while somebody fixes it. Suppression scopes to a rule, a device or a site, and the alarm is still raised, still stored and still shown, carrying the reason nobody was called. "Do not wake anyone" is not the same instruction as "pretend it did not occur", and only the first is ever what an engineer standing at a faulty inverter means |
| 9.8 | — the reason is not optional | `reason` is NOT NULL in the table and non-blank in the API. A suppression nobody can explain is how an installation ends up permanently quiet with the original problem long forgotten, and the row outliving its author is the normal case, not the exception |
| 9.8 | — checked at dispatch, re-checked at escalation | Not at raise time. The ordinary sequence is that an alarm pages somebody, they look at it, and they suppress it while they work; a check that only ran when the alarm first fired would go on escalating the very thing they had just silenced fifteen minutes later |
| 9.8 | Every channel was paged at every hour | An on-call rota: shifts bind a channel to days and hours in a named timezone, reusing the `ems_schedules` window shape (bit 0 = Sunday, equal start and end means all day, an end before the start is a night shift). A night shift belongs to the day it BEGINS, so Friday 22:00–06:00 is still on duty at 02:00 on Saturday rather than being two disjoint pieces of Friday |
| 9.8 | — opt-in, and it fails open | An org with no enabled shifts keeps the previous behaviour exactly: every channel notified. And an hour the rota does not cover still delivers to everyone, with a warning on the screen and in the log — a duplicate page is recoverable, a missed one is not, and a rota that quietly pages nobody because somebody half-configured it is worse than no rota at all. Resolutions bypass the rota entirely: they go to whoever was actually woken, not to whoever is on duty now |
| 9.8 | — one implementation of "who is on duty" | The shift-window decision lives in `contracts/`, so the dispatcher and the "on duty now" badge run the same function. `tzOffsetMs`/`localClock` moved there with it. A second copy on the browser side is how a rota that reads correct on screen pages the wrong person at 03:00 |
| 9.15 | Webhooks were a chat hook, not an integration | `notification_channels` POST alarm JSON at a URL, which is enough for Slack and not enough for anyone building against this system. Nothing SIGNED the payload, so a receiver could not tell a genuine delivery from anyone who learned the URL; a failed delivery was logged and dropped, so a receiver restarting for thirty seconds lost every event in that window permanently; and the only event was "an alarm fired" — control actions, the ones an auditor asks about, were never published. Signed, queued subscriptions with a documented verification procedure now cover all three |
| 9.15 | — the timestamp is inside the MAC | `t=<unix>,v1=<hmac>` over `` `${t}.${rawBody}` ``, not over the body alone. Signing the body alone leaves a captured request valid forever: an attacker replays it unchanged and it still verifies. With the timestamp bound in, moving it breaks the signature and keeping it lets the receiver reject anything past its tolerance. The verifier checks the MAC BEFORE the clock, so a receiver cannot be used to probe which timestamps it accepts without holding the secret |
| 9.15 | — the queue IS the retry | The delivery row is written before anything is sent, so a process dying mid-send resumes instead of losing the event, and the body is frozen at emit time: a retry must re-send the event as it WAS, not as the database looks now — an alarm that has since resolved must never be re-delivered as "raised" carrying a resolved body. Backoff is jittered ±25%, because every delivery to one endpoint fails in the same instant when it goes down, and an unjittered schedule aims the whole backlog at a service that is already struggling |
| 9.15 | — 4xx is not retried, and nothing auto-disables | A 5xx means "not now"; a 4xx means "not ever" — the receiver is telling us the request is wrong, and seven identical retries will not make it right (408 and 429 excepted: both are explicit asks to come back later). The subscription's consecutive-failure count is surfaced but never acted on: an integration that switches itself off is how a customer discovers weeks later that their ERP stopped receiving alarms |
| 9.13 | The REST API had no rate limit | The docs said "front it with your reverse proxy", which is not an answer: a proxy sees an IP and a path, not which API KEY is calling or which SCOPE the call needs, so it cannot tell a polling dashboard from an integration pushing plans, and cannot stop one tenant's key consuming everyone else's capacity. Limits are now per (key, scope), charged against the most specific scope a route requires — a telemetry range scan, a device listing and an EMS plan push do not cost the same, and one shared allowance would have to be priced at the dearest of them |
| 9.13 | — a bucket, in the database, failing open | A token bucket rather than a fixed window, because a fixed window lets a caller spend a full quota at 11:59:59 and another at 12:00:00 — twice the published rate at the worst moment. In the database rather than in process memory, because an in-memory limiter multiplies the quota by the replica count and resets on every deploy, so the documented number stops being the number. And it fails OPEN: a limiter that rejects traffic because its own bookkeeping is unavailable has turned a storage problem into a total outage of the public API |
| 9.13 | — the clock is not trusted to run forwards | Elapsed time is clamped at zero. Skew between replicas or an NTP step backwards would otherwise compute a negative refill and DRAIN the bucket, which is the one way a rate limiter can lock out a caller who did nothing wrong. Rejected requests write nothing at all — the refill is a pure function of elapsed time, so the next read derives it again, and a client hammering an exhausted limit costs reads rather than amplifying writes |
| 9.13 | No machine-readable API contract | `GET /api/v1/openapi.json` now serves an OpenAPI 3.1 document, behind the same key as everything else. Hand-written, because nothing in this stack generates one from Hono handlers — and therefore paired with a test that walks the routes Hono actually registered and fails in BOTH directions: a route with no spec entry, and a spec entry for a route that no longer exists. The second is the one that bites, because a client generated from it finds the 404 in production. The test is what makes the file a contract rather than documentation |
| 9.14 | A tenant's data could not leave | The only routes out were a scheduled energy report (one metric, emailed) and direct database access (everyone's data at once). Neither answers "give us our data", which arrives as a contract clause, as a regulator's question, or on the day a customer moves supplier. Per-org export now writes sites, gateways, devices, users, alarms and the control audit trail as NDJSON, with raw telemetry optional and range-bounded, built in the background because a year of interval data for one site is tens of millions of rows. Password hashes and MFA secrets are excluded: an export is a copy of a tenant's DATA, not of the things protecting their accounts |
| 9.14 | — admin, not superadmin, and counted | Making export superadmin-only would route every "give us our data" request through whoever holds the platform account. Per-table row counts ship with the archive so the recipient can check they got everything rather than trusting that a file which opened is a file that is whole, and a build that fails deletes its half-written file — an incomplete archive looks like data and is not |
| 9.14 | Retention was one number for everybody | A tenant under a regulator requiring five years of interval data and one who wants nothing kept past a month are both reasonable; a single TELEMETRY_RAW_DAYS has to be wrong for one of them. The catch is that the purge sweeps a shared table, so it now runs at the LONGEST retention anyone asked for and applies shorter ones as targeted deletes — otherwise the global sweep would delete, at ninety days, the very rows somebody is paying to keep for five years. A single-tenant deployment does exactly what it did before |
| 9.14 | — and rolls up before it deletes | To the LATEST cutoff in the plan, not the earliest: a tenant on a seven-day retention would otherwise lose hours that never reached an aggregate, and their reports would go blank rather than coarse |
| 9.14 | "Delete our data" had no implementation | The nearest thing was deleting rows by hand in whatever order occurred to whoever held the console, which is how a tenant ends up gone from the org table and still present in telemetry, alarms and the command audit trail. Deletion is now scheduled with a grace period, children before parents, every table counted — and the counts logged, because this is the one operation with nothing left to inspect afterwards. Scheduled rather than immediate because an irreversible delete executed the instant somebody clicks has no way back from a misclick; cancelling during the window is a supported action rather than a database restore. Typing the org's exact name is required, and deleting your OWN org is refused — it would delete your account mid-request and leave the purge half-done with nobody able to sign in and finish it |
| 9.11 | A user belonged to exactly one org, forever | Two ordinary situations were therefore impossible: an engineer looking after three customers' sites needed three accounts, and an installer had to be brought in by an admin typing a password on their behalf and sending it over chat. Memberships are ADDITIVE rather than a rewrite of the scoping model — `users.org_id` and `users.role` keep their meaning as the ACTIVE org and the role in it, so every org-scoped query, guard and router is untouched. Switching checks a membership and moves those two fields; the invariant is one sentence, and the migration backfills every existing user so nobody opens the switcher and finds they belong to nothing |
| 9.11 | — a role PER org, not one globally | The same person is an operator for one tenant and a viewer for another, which is what a contractor looking after several customers actually needs. A superadmin can act anywhere without holding a membership row in every tenant: requiring one would make an org nobody remembered to add them to invisible to the one account meant to see everything, and the switcher says "platform admin" so "why am I an admin here" stays answerable |
| 9.11 | — and leaving is handled, not just joining | Removing somebody from the org they are ACTING under moves them to another membership they still hold, or disables the account when none is left. An account signed in with no tenant is not a state anything downstream expects. Removing your own membership is refused |
| 9.11 | Onboarding meant typing someone's password for them | Invitations: a hashed token (like a session and an API key — a database dump must not hand somebody the ability to create accounts in every tenant with an invite outstanding), expiring by default in seven days and capped at ninety, single use, revocable. The link is emailed when a mailer is configured and ALWAYS returned to the inviter, because a deployment with no SMTP still has to be able to invite somebody. Accepting an invite for an address that already has an account adds a membership and NEVER touches the password — otherwise knowing a colleague's email would be a way to reset it. And accepting does not create a session: a link in an inbox should not be enough to be signed in |
| 9.9 | Firmware could only be pushed one gateway at a time | So a fleet update was a script looping over every gateway, which is how an installation loses all of them at the same moment to a bad image. Rollouts now stage: a canary batch of its own — a rollout that starts with ten is a rollout that can break ten — then fixed waves, with each wave's result known before the next is exposed. There is deliberately NO automatic rollback: firmware cannot be reliably rolled back over the air, and a gateway that boots into an image which no longer reaches the broker is beyond anything this system can do. Halting and telling somebody is the honest behaviour, which is also why a halted rollout offers no resume — resuming would push the same image again |
| 9.9 | — any canary failure halts, whatever the threshold says | One device out of one is a 100% failure rate however it is phrased, and the canary's whole job is to answer "does this image work at all". Later waves use the configured percentage. A wave is judged when it SETTLES rather than when the next one is considered, so a rollout whose last wave failed cannot report itself complete |
| 9.9 | — membership is frozen, and delivery is not reimplemented | Targets are written when the rollout is created rather than re-derived from a filter each sweep: a gateway that comes online halfway through must not silently join a wave that has already been judged. Each target carries an ordinary OTA job id, so the existing manager still does the publishing, ack timeouts and retries, and the rollout reads their status back — one delivery path, not two that can disagree. Rollouts advance inside the OTA sweep for the same reason: a separate timer would decide the next wave from a view of the previous one that was already stale |
| 9.9 | Firmware was a URL somebody typed | A release registry with model, version, URL and sha256. "Which bytes did we ship" now has an answer months later, when the question is asked by somebody holding a device that no longer boots |
| 8 | No global search, no column sorting | Ctrl/Cmd-K over gateways, devices and sites, matching a gateway on its UID as well as its name; the lists load only while the palette is open. Click-to-sort on the two long tables, cycling back to the server's own ordering, with nulls last in both directions |

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
- **§1.4, broker-derived identity.** A device can now be given its tenant in advance or by a
  single-tenant default, and an unregistered one is visible in the queue rather than lost. What
  still does not exist is deriving the tenant from a broker-authenticated client identity, so
  that open enrolment on a multi-tenant broker needs no paperwork at all. That is broker
  configuration (EMQX authentication plus either a tenant-carrying topic or an MQTT 5 user
  property), which this repository cannot make on its own.
- **`powerTrend` past the cutoff.** Unchanged and deliberately so: its input is capped at 168
  hours, so it cannot reach the 90-day cutoff in the first place.
- **Advisories: 16 down to 9, none reaching a shipping package.** Measured on the runner: 16
  (1 low, 13 moderate, 2 high) became 9 (1 low, 8 moderate, 0 high). The `uuid` advisory, the
  only one that reached a runtime dependency, is closed by the override above. The rest are
  build tooling (vitest, esbuild via drizzle-kit, postcss): reported every run, not blocking,
  and not reachable by an attacker against a deployed gateway.
- **Offset pagination in the UI.** The REST API is keyset-paginated and the lists the UI shows
  are org-scoped and now sortable and searchable; paging the tables themselves is UX work
  nobody has asked for rather than a defect.
- **§9, the recommended new functions.** Still a roadmap rather than a defect list. Twelve have
  landed: the setpoint deadman (§9.1), the grid connection limit with curtailment (§9.2), the
  emergency stop and command dry-run (§9.4), device-offline alarming (§9.6), data-quality
  monitoring (§9.7) in both halves, alarm suppression with an on-call rota (§9.8), signed,
  retried webhook subscriptions (§9.15), per-scope REST rate limits with a published OpenAPI
  document (§9.13), per-org export, retention and deletion (§9.14), and org membership with
  invites and switching (§9.11), and staged fleet firmware rollouts (§9.9).
  §9.8 was the right one to take after §9.6 and §9.7: those two made the system fire MORE
  alarms — a frozen register and a silent gateway both page now where neither did before — and
  the machinery for deciding which of them is worth waking a person for had not moved since
  maintenance windows. Adding detection without adding judgement is how an installation learns
  to ignore its own alarms.

  The remaining four are real but none of them blocks anything. OIDC single sign-on (§9.12) is
  the one with the most commercial weight — a procurement blocker for industrial customers
  rather than a feature — and is also the first item here that cannot be proved in CI: there is
  no identity provider on a runner, so the flow can be unit-tested and shipped behind a flag but
  not demonstrated end to end without a real tenant.

  **Not built in §9.7: gap detection as an alarm.** The largest gap inside an hour needs a
  window function, and a TimescaleDB continuous aggregate does not allow one — building it on
  MySQL alone would give the two stores different answers, which is the class of bug this
  branch spent its time removing. A device that stops reporting entirely is already covered by
  the offline alarms.
