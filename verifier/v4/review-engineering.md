# v4 — Engineering review: illogicalities & shortcomings

Principal-engineer review of the Enertrek Cloud platform (reviewer subagent,
findings confirmed against the live database and code). Severity scale:
CRITICAL / HIGH / MEDIUM / LOW. Dispositions marked **[FIXED v4]** have code
changes in this version; others are documented roadmap items with rationale.

## Data integrity

**#1 CRITICAL — Inconsistent cascade deletes.** `gateways.remove` deleted the
gateway row but left meters, telemetry and alarms behind; `meters.remove` left
telemetry and alarms. Live DB evidence: 22,290 of 36,397 telemetry rows
pointed at deleted meters; alarms id 90003 and 30001 were "immortal" (their
meter/rule rows gone, alarm rows undeletable through the UI).
**[FIXED v4]** — `gateways.remove` now cascades (telemetry + alarms chunked by
500 via `inArray`, then meters, then gateway; returns `removedMeters`);
`meters.remove` deletes alarms + telemetry first. `scripts/repair-orphans.ts`
cleaned the existing damage: 22,290 telemetry orphans, 20 alarm orphans,
immortal alarms 90003/30001 confirmed gone, stray `test` gateway removed.

**#2 HIGH — Offline threshold vs poll interval flapping.** The 120 s offline
cutoff is shorter than configured poll intervals (up to 3600 s), so slow-poll
devices flap online/offline. **Roadmap** — per-device threshold derived from
`pollInterval` (e.g. 2.5× interval, min 120 s).

**#3 HIGH — Telemetry batch writer has no retry/backpressure/drain.** A failed
batch is dropped; shutdown loses the in-memory queue; unbounded growth under a
down DB. **Roadmap** — bounded queue + retry with backoff + flush on SIGTERM.

**#4 HIGH — `subscribe("#")` + auto-provision.** Any published topic creates
fleet rows (see F-03; stray `uid='test'` gateway was found in the DB).
**[FIXED v4 — gate]** `MQTT_AUTO_PROVISION=0` disables auto-provisioning;
topic-space restriction to `d2g/#` + known prefixes remains roadmap.

**#5 HIGH — Timescale store drops `values_json`.** The Timescale telemetry
path persists fewer fields than the MySQL store, so switching stores silently
loses data. **Roadmap** — schema parity migration.

**#6 HIGH — `updateMap` zod schema stripped codec fields.** The register-def
schema lacked `offset`/`addressStride`, so any UI edit of an ESMU profile
silently deleted the fields that make ESMU decoding work.
**[FIXED v4]** — both fields added to `registerDefSchema` in
`api/routers/profiles.ts`.

**#7 HIGH — Alarm restart/ack stuck states.** `breachState` is in-memory only:
a restart with an active breach re-fires duplicate alarms; acknowledged alarms
can re-fire because ack state isn't part of breach evaluation. **Roadmap** —
persist breach state / evaluate ack in the resolver.

**#8 HIGH — Three different "days".** Server aggregates in CST, the DB stores
UTC, the browser renders local time — daily energy totals shift depending on
where you look. **Roadmap** — explicit per-site timezone, UTC storage,
single-point conversion.

## Logic / consistency (MEDIUM)

**#9 — W→kW heuristic.** Power keys arrive in mixed units; a heuristic guesses
per key name. Roadmap: unit metadata in register maps.
**#10 — Poller collateral socket kill.** `dropConn` on any poll error closes
the shared socket, failing every other device on that gateway.
**#11 — Poller `getConn` race** — concurrent first polls open duplicate
sockets; last writer wins, the other leaks.
**#12 — Poller busy-spin without backoff** when a device errors continuously.
**#13 — Dashboard KPIs ignore `PRIMARY_POWER_KEY`** contract and re-derive
power keys ad hoc.
**#14 — `alarms.counts` full table scan** on every dashboard load.
**#15 — Liveness coalescer dropped fresh marks.** After a chunk flush, the
code cleared the whole `seen` set — marks recorded *during* the flush were
lost, delaying online transitions by a full sweep.
**[FIXED v4]** — only flushed ids are removed (`seen*.delete(id)` per chunk).
**#16 — No cache eviction on delete** — `gwCache` (5 min TTL) keeps serving
deleted gateways; a re-provisioned gateway can resurrect with a stale row.
**#17 — `sendReadNow` hangs forever** when the broker is disconnected
(publish callback never fires). **[FIXED v4]** — `client.connected` pre-check
+ 10 s `Promise.race` timeout.
**#18 — Reports N+1** query pattern per meter per day.
**#19 — Alarm UI exposes only 14 metrics** although profiles define dozens
(e.g. all ESMU keys) — users can't rule on them from the UI.

## UX / contracts (LOW)

**#20 — `MeterDetail` hardcodes `activePowerKw`** instead of using the model's
primary-key contract.
**#21 — Energy totals mix measured and derived values** without labeling.
**#22 — Simulator/dev-only scripts share the production DB by default**
(`.env` is the only switch) — easy to pollute prod data.

## Process

**#23 — Zero automated tests.** Only ad-hoc `scripts/test-*.ts` e2e harnesses
exist (pv/scale/esmu); no unit tests, no CI gate. Roadmap: vitest for
codec/routers + the existing e2e scripts wired into CI.
**#24 — No migrations tool in the loop** — schema changes are applied by hand
against TiDB; drizzle-kit migrations exist but aren't enforced.

## Fixed in v4 (summary)

| Finding | Fix |
|---------|-----|
| #1 cascade deletes + orphan data | routers cascade; `repair-orphans.ts` run (22,290 telemetry + 20 alarms + stray gateway) |
| #6 zod strips codec fields | `offset`/`addressStride` in `registerDefSchema` |
| #15 liveness drops marks | per-chunk delete instead of blanket clear |
| #17 sendReadNow hang | connected-check + 10 s timeout |
| #4 (with F-03) rogue auto-provision | `MQTT_AUTO_PROVISION=0` gate |

All other findings: documented roadmap with severity and rationale above.
