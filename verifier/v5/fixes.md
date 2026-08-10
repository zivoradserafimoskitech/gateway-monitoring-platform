# v5 — all 19 remaining engineering findings: fixes & evidence

Every finding from `verifier/v4/review-engineering.md` that v4 deferred is now
resolved. Date: 2026-08-10. Acceptance: `verifier/v5/acceptance.md`.

## HIGH

**#2 Offline threshold vs poll interval — FIXED.**
New pure module `api/mqtt/offline.ts`: `offlineThresholdMs(pollIntervalSec) =
max(120s, 2.5×interval)`. `offlineSweep` (api/mqtt/service.ts) now evaluates
meters per-device (chunked updates), and gateways inherit the slowest poll
interval of their meters. A 3600 s device now goes offline after 2.5 h, not
120 s. Unit test: `tests/poller-backoff.test.ts` (floor, default, 3600 s).

**#3 Batch writer durability — FIXED.**
`api/telemetry/index.ts` BatchWriter: bounded queue (`TELEMETRY_QUEUE_MAX`,
default 50 000, oldest-dropped + `dropped` stat), retry with exponential
backoff (2 s→30 s cap, `TELEMETRY_RETRY_MAX` = 5 attempts before a batch is
counted `failed`), and graceful-shutdown drain (`drain()` + SIGTERM/SIGINT
hook, `TELEMETRY_DRAIN_MS` budget). Unit tests `tests/batch-writer.test.ts`:
drain-everything, retry-then-succeed, poison-batch drop accounting,
backpressure bound — all green.

**#5 Timescale store drops values_json — FIXED.**
`values_json jsonb` added to `db/timescale/001_init.sql` (+ inline ALTER note
for existing deployments), to `COLS`/insert in `timescale-store.ts`, and
`latest`/`latestAll` now merge the open key map exactly like the MySQL store.

**#7 Alarm restart/ack stuck states — FIXED (three layers).**
1. Acknowledged alarms count as ongoing conditions: duplicate suppression and
   auto-resolve now use `status IN ('active','acknowledged')` in
   `evaluateAlarmRules` and the gatewayOffline sweep.
2. Race-proofing: new generated column `alarms.active_dedup_key` +
   `alarms_active_dedup_uniq` unique index (db/schema.ts, migration
   `db/migrations/0001_*.sql`, applied live via
   `scripts/apply-dedup-migration.ts`). Concurrent/reloaded evaluators can't
   double-fire — the loser's insert hits the unique index and is skipped
   (`isDuplicateKey`). Pre-existing duplicates resolved by
   `scripts/dedupe-active-alarms.ts` (3 dupe groups).
3. Verified live: direct duplicate INSERT rejected (`probe-dedup-constraint.ts`
   PASS); app restart during an active breach → 0 new alarms; ack during
   breach → 0 re-fires after 75 s+ of continued breach.

**#8 Three timezone "days" — FIXED.**
Server-side day bucketing is UTC everywhere: MySQL `dailyReport` groups by
`floor(unix_timestamp(ts)/86400)` (epoch = UTC calendar day, immune to session
TZ; day string rendered in JS via `toISOString()`); dashboard "today" starts
at UTC midnight (was server-local `setHours`); Timescale documents
`time_bucket('1 day')` = UTC. Policy recorded in README.

## MEDIUM

**#9 W→kW heuristic — FIXED.** `normalizeValues` takes per-profile unit hints:
declared "W"/"var"/"VA" always convert, "kW"-class never convert; magnitude
heuristic is fallback only. Tests: `tests/normalize.test.ts` (6 MW-in-kW no
longer mangled; 800 W now converts).

**#10 Poller collateral socket kill — FIXED.** `runTask` drops the shared
socket only when `isTransportError(err)` (ECONN*/socket-closed); Modbus
exceptions and per-unit read timeouts are device-level and leave the socket
for the other units. Helper + tests in `api/poller/backoff.ts`.

**#11 getConn race — FIXED.** In-flight connect promises memoized per
host:port (`pendingConns`); concurrent first polls share one connect.

**#12 Busy-spin — FIXED.** Socket `busy` wait is bounded (15 s) and poll
backoff centralized in `nextBackoffMs` (unit-tested).

**#13 Dashboard KPIs ignore contracts — FIXED.** `dashboard.overview` uses
`PRIMARY_POWER_KEY[deviceType]` for fleet power and
`ENERGY_COUNTER_KEY[deviceType]` for energy-today; `firstEnergyAll` coalesces
the column with `values_json` counters (`energyTotalKwh` /
`dischargeEnergyTotalKwh`) in both stores, so inverters/BESS contribute.

**#14 alarms.counts full scan — FIXED.** SQL `count(*) ... group by status`.

**#15** fixed in v4 (liveness coalescer per-chunk delete) — re-verified by e2e.

**#16 Cache eviction on delete — FIXED.** `evictGatewayCache(uid)` (mqtt
service) called from gateways.update/remove; `clearMeterCache()` (handlers)
called from gateways.remove/meters.remove.

**#18 Reports N+1 — FIXED.** One `inArray` metadata query for all meters +
parallel `dailyReport` calls (was serial per-meter-per-day metadata + series).

**#19 Alarm UI only 14 metrics — FIXED.** Rule metric is now an open string
(backend zod `string(1..100)`); the UI dropdown is populated from the actual
device-profile register maps — the selected meter's profile, or the union of
all profiles for fleet-wide rules (units shown from profile metadata).

## LOW

**#20 MeterDetail hardcodes activePowerKw — FIXED.** `meters.history` derives
the meter's PRIMARY_POWER_KEY and both stores average it (column fast path;
`values_json` extraction otherwise — verified live on TiDB: Victron
batteryPowerKw avg 6.05 kW / 833 samples). `HistoryPoint.powerKw`; the chart
plots `powerKw` with the contract label/unit. Note: the ESMU profile
legitimately has no batteryPowerKw register (V/I only) → empty series is a
profile gap, not a bug; add a computed register if ESMU power is needed.

**#21 Mixed measured/derived energy — FIXED.** `DailyReportRow.demandDerived`
(demand samples = 0 while a max exists) in both stores; Reports table marks
derived demand with "≈" + tooltip.

**#22 Scripts share prod DB — FIXED.** `scripts/lib/db-guard.ts`:
destructive scripts (cleanup-scale, clean-orphans, clear-telemetry,
cleanup-pv-scale, repair-orphans) print the target host and REFUSE non-local
DBs unless `ALLOW_UNSAFE_PROD=1`. Verified: refusal and override both work.

## Process

**#23 Zero automated tests — FIXED.** `npm test` (vitest) → 20/20 green across
5 suites: codec (offset/stride/u32 order), CSV injection guard, poller
backoff/transport classification, offline thresholds, G30 unit hints, batch
writer durability. vitest.config now includes `tests/` + `@db` alias.

**#24 Migrations by hand — FIXED.** drizzle-kit wired: `npm run db:generate` /
`db:migrate`; `db/migrations/0000` (baseline) + `0001` (dedup index)
generated; README ops note mandates the workflow (with the Timescale SQL path).
