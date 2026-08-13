# DR drill evidence — 2026-08-13 (audit wave 3, "DR tested")

Scope: backup → restore drill (DR-1) and embedded-broker failover drill (DR-2)
on the VoltTrade Cloud demo environment (TiDB Serverless + embedded aedes dev
broker + watchdog-supervised sims/dev server). Executed by the audit DR agent.

## TL;DR

| Drill | Result | Key numbers |
|---|---|---|
| DR-1 backup → scratch restore | **PASS** (all 7 key tables, counts + sha256 id-checksums equal) | backup 11.7 s · verify 3.6 s · restore 2.9 s · drop 0.4 s |
| DR-2 broker kill → watchdog recovery | **PASS** | watchdog restart 20 s · readyz 200 in ≤ 59 s · 0 rows lost · ~60 duplicate rows (at-least-once, documented tolerance) |
| Organic outage #1 (09:36Z–10:19Z) | recovered by watchdog | services restarted 10:19:47Z, broker re-start 10:20:19Z |
| Organic outage #2 (11:08Z–12:21Z) | **watchdog itself dead 73 min** | manual watchdog restart 12:21:23Z — see Finding C |

## DR-1: backup → restore drill

Script: `scripts/dr/backup-restore-drill.ts` (gated by `ALLOW_DR_DRILL=1`;
without it the script is a dry-run that only prints the plan).

Steps executed (`ALLOW_DR_DRILL=1 npx tsx scripts/dr/backup-restore-drill.ts`):

1. Full backup with the existing mechanism (`scripts/backup-db.ts`) →
   `/tmp/dr-drill-backup/2026-08-13T12-32-26-970Z` — 11,731 ms.
2. `restore-db.ts --verify` — backup complete and consistent — 3,586 ms.
3. `CREATE DATABASE volttrade_dr_drill` on the same TiDB — privilege OK
   (no fallback needed).
4. Restored the 7 audit tables from the backup files into the scratch DB
   (`CREATE TABLE … LIKE` + chunked inserts, ISO dates revived) — 2,908 ms.
5. Compared prod vs backup vs scratch — row counts equal and per-table
   sha256 checksums over sorted primary keys equal:

   | table | prod | backup | scratch | checksum |
   |---|---|---|---|---|
   | users | 3 | 3 | 3 | ok |
   | sites | 2 | 2 | 2 | ok |
   | meters | 18 | 18 | 18 | ok |
   | gateways | 5 | 5 | 5 | ok |
   | ems_plans | 0 | 0 | 0 | ok |
   | api_keys | 40 | 40 | 40 | ok |
   | audit_log | 364 | 364 | 364 | ok |

6. `DROP DATABASE volttrade_dr_drill` (scratch only) — 419 ms; verified gone
   via `SHOW DATABASES LIKE 'volttrade_dr_drill'` → empty.

Verbatim log (abridged, full log at `logs/dr-drill-backup-restore.log`):

```
[dr-drill] backup done in 11731ms → /tmp/dr-drill-backup/2026-08-13T12-32-26-970Z
PASS restore-db --verify: backup complete and consistent -> {"ms":3586}
[dr-drill] scratch database volttrade_dr_drill created
[dr-drill] restored audit_log: 364 rows → volttrade_dr_drill
PASS row counts prod>=backup==scratch (api_keys) -> {"prod":40,"backup":40,"scratch":40,"checksumOk":true}
PASS id checksum backup==scratch (api_keys) -> {"backup":"d2f29f1e609700ca","scratch":"d2f29f1e609700ca"}
[dr-drill] scratch database volttrade_dr_drill dropped
[dr-drill] timings: {"backupMs":11731,"verifyMs":3586,"restoreMs":2908,"dropMs":419}
=== DRILL PASS
```

Backup manifest (all tables): sites 2, gateways 5, meters 18, telemetry
99,814, telemetry_hourly 275, alarm_rules 7, alarms 46, device_profiles 33,
commands 118, users 3, sessions 179, audit_log 364, notification_channels 0,
alarm_notifications 0, maintenance_windows 0, api_keys 40, ems_plans 0.

**Confirmation runs (after the backup/restore coverage fix, Finding A):**

- `scripts/probe-v7-backup.ts` re-run against the new 22-table path —
  **ALL PASS** (`logs/dr-probe-v7-backup-gw3.log`):
  `PASS backup manifest covers all 22 tables; telemetry count in range -> {"tables":22,"backupTel":102120,"liveTel":102160}`,
  canary loss → full recovery, remote-guard refusal intact.
- Drill re-run at 12:54Z — **DRILL PASS** with the fixed `backup-db.ts`
  covering `api_keys`/`ems_plans` natively:
  `timings: {"backupMs":11436,"verifyMs":3513,"restoreMs":2757,"dropMs":387}`,
  same 7-table counts/checksums all equal
  (`logs/dr-drill-backup-restore-run2.log`).

## DR-2: broker failover drill

Pre-checks: no probe running (`pgrep -f probe-v` clean). Pre-kill state
12:41:07Z: `/readyz` = `{"status":"ready","components":{"db":"ok","broker":"ok","brokerMode":"embedded-dev"}}`,
telemetry total 100,508 rows, 171 rows in the last 2 min (~1.42 rows/s).

Timeline:

| t (UTC) | event |
|---|---|
| 12:41:07 | `pkill -f "scripts/broker.ts"` — 3 broker processes killed |
| 12:41:27 | watchdog: `starting broker` (**+20 s**) |
| ~12:41:30 | broker.log: `aedes listening on 0.0.0.0:1883`, clients `enertrek-sim-…` and `enertrek-cloud-…` reconnect |
| 12:42:06 | `/readyz` = 200 ready (**≤ +59 s**, poll granularity 5 s) |

Verbatim lines:

```
# watchdog.log
2026-08-13T12:40:57Z watchdog: heartbeat
2026-08-13T12:41:27Z watchdog: starting broker
2026-08-13T12:41:27Z watchdog: heartbeat

# broker.log (after restart)
[broker] aedes listening on 0.0.0.0:1883
[broker] aedes TLS listening on 0.0.0.0:8883 (mqtts)
[broker] client connected: enertrek-sim-1786623688158
[broker] client connected: enertrek-cloud-0d342e79

# dev.log (app MQTT client riding through the outage)
[mqtt] client error: connect ECONNREFUSED 127.0.0.1:1883   (×4 retries)
[mqtt] connected to mqtt://127.0.0.1:1883
[mqtt] subscribed to #
```

Data-path assessment (telemetry DB counts):

- 152 rows landed with ts inside the 90 s outage window 12:41:00–12:42:30
  (expected ≈ 128 at the 1.42 rows/s baseline) → **no loss**.
- Duplicates: 60 `(meter_id, ts)` groups with n=2 in 12:40:30–12:43:30 vs
  **0** in the 3 min baseline before the kill (270 rows) → ~60 extra rows
  from at-least-once redelivery (sim mqtt.js offline queue flushed on
  reconnect). Telemetry has no unique constraint by design; energy reports
  use counter deltas and are not distorted (see runbook).
- No WAL replay was involved: the app process survived the drill (only the
  broker was killed); the ingestion WAL protects app crashes, not broker
  outages.
- Post-drill: `/readyz` ready, sims alive (`pv-sim`, `esmu-sim`, `mqtt-sim`
  untouched by the drill), telemetry flowing (115 rows/60 s after recovery).

## Organic watchdog evidence (same day)

Two full-environment outages happened organically on 2026-08-13 (sandbox
idle cleanup kills daemons):

**Outage #1** — heartbeat gap 09:36:33Z → 10:19:47Z (~43 min). Watchdog
recovered the whole stack on its own:

```
2026-08-13T10:19:47Z watchdog: starting broker
2026-08-13T10:19:47Z watchdog: starting pv-sim
2026-08-13T10:19:47Z watchdog: starting esmu-sim
2026-08-13T10:19:49Z watchdog: starting mqtt-sim
2026-08-13T10:19:49Z watchdog: starting dev-server
2026-08-13T10:20:19Z watchdog: starting broker   # first start had not bound :1883 within one cycle
```

**Outage #2** — heartbeat stopped 11:08:24Z and the watchdog daemon itself
was dead for **73 min**; services stayed down until the watchdog was
restarted manually at 12:21:23Z, after which it restarted broker/sims/dev
server in one cycle:

```
2026-08-13T12:21:23Z watchdog: starting broker
2026-08-13T12:21:23Z watchdog: starting pv-sim
2026-08-13T12:21:23Z watchdog: starting esmu-sim
2026-08-13T12:21:24Z watchdog: starting mqtt-sim
2026-08-13T12:21:25Z watchdog: starting dev-server
```

## Findings

- **A (fixed in this wave): backup/restore coverage gap.** `backup-db.ts` and
  `restore-db.ts` still carried the v7 15-table list — `api_keys`,
  `ems_plans`, `orgs`, `ems_schedules`, `ems_peak_shaving`,
  `report_schedules`, `ota_jobs` were silently excluded from backups.
  Discovered by the drill; fixed by extending both scripts to all 22 tables
  (probe `scripts/probe-v7-backup.ts` re-run green against the new list).
- **B: WAL writer vs stale FUSE dir.** After outage #2 the dev server held a
  stale view of `data/wal/`; `walAppend` logged `ENOENT` continuously
  (~1.7/s) even though the dir existed and fresh processes could write.
  Ingestion is unaffected (in-memory path + MySQL flush), but crash
  protection is absent until the app process restarts. Self-heal
  (mkdir+retry) cannot fix a mount-level staleness — process restart does.
- **C: the watchdog has no supervisor.** Outage #2 lasted 73 min only
  because nothing restarts the watchdog itself. Recommendation: run
  `scripts/watchdog.sh` under systemd/cron `@reboot` (or a meta-cron that
  execs it if missing) so heartbeat gaps self-resolve.
- **D (known/by design):** a ~35 s broker outage produces ~60 duplicate
  telemetry rows via at-least-once redelivery. Within documented tolerance;
  consider an idempotency key `(meter_id, ts)` if exact-once is ever needed.

## Schedule

DR drills run **quarterly**: next drill **2026-11-13** (backup→scratch
restore + one component kill; rotate the killed component: broker → app
replica → DB failover simulation). Drill script:
`ALLOW_DR_DRILL=1 npx tsx scripts/dr/backup-restore-drill.ts` (dry-run
without the env flag). Evidence template = this file.
