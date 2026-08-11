# Operator incident runbooks (D9)

First-response procedures for the VoltTrade Cloud platform. Backup/restore
detail lives in `docs/runbook-backup-dr.md`; TLS in `docs/tls.md`.

General triage order: **Alarms page** (platform watchdog alarms are
critical) → `/metrics` → app/broker logs.

---

## 1. MQTT broker down

**Symptoms:** watchdog alarm `platformWatchdogMqtt` ("MQTT ingestion is
disconnected / not running"); gateways show offline; no new telemetry from
MQTT devices (direct-TCP polled devices keep working).

**Actions:**
1. Check the embedded broker process/log (`npx tsx scripts/broker.ts`) —
   crash-loop usually means a TLS cert problem (`MQTT_TLS_KEY`/`MQTT_TLS_CERT`
   unreadable/expired) or port 1883/8883 already bound.
2. If `MQTT_URL` points at an external broker, check that broker's health
   and the platform client's auth (`MQTT_USERNAME`/`MQTT_PASSWORD`).
3. Restart the broker, then confirm the watchdog alarm auto-resolves
   (within ~1 min — the watchdog ticks every 60 s).
4. Gateways reconnect and backfill from their own buffers if they have any;
   otherwise there is a telemetry gap for the outage window. The local WAL
   only protects rows that already reached the platform.

**Escalate if:** broker won't stay up > 10 min, or TLS handshake failures
persist after cert renewal.

## 2. Poller stall (watchdog alarm fires)

**Symptoms:** watchdog alarm `platformWatchdogPoller` ("N Modbus device(s)
configured but no successful poll in the last 5 minutes"); direct-TCP
devices stale in the UI.

**Actions:**
1. `GET /metrics` — check the poller/telemetry counters
   (`enertrek_telemetry_rows_*`) and per-device stats.
2. Narrow the blast radius: ALL devices stale → network egress, DB write
   path, or poller supervisor dead (restart app). ONE device stale → that
   device/network: it may have dropped the socket (e.g. ESMU drops idle
   sockets at 30 s — keep `pollIntervalSec` < 30) or changed IP.
3. Use Devices → **Test connection** against an affected device to get the
   exact transport error (timeout vs refused vs illegal-address).
4. Poll failures back off exponentially by design (`api/poller/backoff.ts`);
   a device that recovers resumes on its own — no restart needed.
5. Watchdog auto-resolves once a poll succeeds.

## 3. Database unreachable

**Symptoms:** API errors/timeouts; telemetry rows pile up in the WAL;
`enertrek_telemetry_rows_failed_total` climbs; watchdog may also fire
(poll attempts fail at the persistence step).

**Actions:**
1. Verify connectivity to MySQL/TiDB (`DATABASE_URL`) — network, credentials,
   server up. The batch writer retries with backoff; **rows are safe** in
   `data/wal/` while this lasts.
2. Fix the DB. On recovery the writer drains the WAL automatically —
   confirm with `/metrics` (rows-written catches up, failed counter stops
   growing) and check `data/wal/` empties.
3. If the app was restarted/crashed during the outage, see runbook 5.

**Do not:** delete `data/wal/` to "clear the backlog" — that is the
backlog. Only rows that exhausted retries land in the failed counter.

## 4. Alarm flood

**Symptoms:** hundreds of alarms in minutes; notification channels
(email/webhook) spamming; escalation loop active.

**Actions:**
1. Identify the dominant metric/rule on the Alarms page (sort newest).
   Common roots: a threshold rule mis-set after commissioning a new model
   (unit mismatch — raw vs scaled), a gateway flapping (`gatewayOffline`),
   or a real plant event.
2. Acknowledge the affected alarm group to stop escalations while you work.
3. Fix the rule (threshold/unit/scope) or the device mapping. Duplicate
   active alarms are suppressed by the dedup key (`alarms.active_dedup_key`)
   — a flood means many DISTINCT breaches, so look for the pattern, not a
   platform bug.
4. If a webhook channel is amplifying the flood, disable that channel in
   Settings temporarily; the alarm rows remain.
5. After the fix, bulk-resolve the stale active alarms from the Alarms page
   (`scripts/dedupe-active-alarms.ts` exists for pathological duplicates).

## 5. WAL replay after crash/restart

**Symptoms:** app was killed (OOM, deploy, power) while telemetry was
queued.

**What happens automatically:** on boot the WAL writer rotates any
`data/wal/pending.jsonl` left by the crash into a replay segment and
replays every `f-*.jsonl` segment before/while accepting new rows
(`api/telemetry/index.ts`). Semantics are **at-least-once** — a few
boundary rows may be written twice. Telemetry has no unique constraint;
energy reports are unaffected because they use counter deltas.

**Actions:**
1. Nothing, normally — verify instead: `data/wal/` should drain to no
   leftover `f-*.jsonl`; `/metrics` rows-written catches up.
2. If a segment is corrupt (truncated final line from the crash), the
   replay logs the failure; salvage by removing the malformed last line of
   that file with the app stopped, then start the app.
3. `scripts/wal-crash-child.ts` + the v7 WAL probe
   (`scripts/probe-v7-wal.ts`) reproduce/verify this path on a test
   deployment.

## 6. Restore from backup (DR)

Follow `docs/runbook-backup-dr.md` exactly. Summary:

1. `npx tsx scripts/restore-db.ts <backup-dir> --verify` — check the
   backup **before** touching anything.
2. `ALLOW_UNSAFE_PROD=1 npx tsx scripts/restore-db.ts <backup-dir> --yes` —
   DESTRUCTIVE replace of all 15 tables; both safeguards are mandatory on
   non-local databases.
3. Restart the app; the WAL replays rows queued since the backup moment
   (at-least-once, boundary duplicates possible — harmless to energy
   reports).
4. Expect users to log in again (sessions restored from backup state).

---

## Quick reference

| Signal | Where |
|---|---|
| Platform watchdog alarms | Alarms page, metrics `platformWatchdogMqtt` / `platformWatchdogPoller` |
| Prometheus metrics | `GET /metrics` (unauthenticated by design — restrict at proxy) |
| Access/error log with request ids | app stdout (`x-request-id` header per call) |
| Telemetry WAL | `data/wal/` (`pending.jsonl` + `f-*.jsonl` segments) |
| Backup/restore scripts | `scripts/backup-db.ts`, `scripts/restore-db.ts` |
| Control audit trail | `commands` table (every attempt, success and failure) |
