# Backup & disaster-recovery runbook (v7/C10)

> **Tested 2026-08-13** — full backup→scratch-restore drill executed green
> (see `docs/DRILL-EVIDENCE.md`). Drill script:
> `ALLOW_DR_DRILL=1 npx tsx scripts/dr/backup-restore-drill.ts` (dry-run
> without the env flag). Drills run quarterly; next: 2026-11-13.

## What is backed up

`scripts/backup-db.ts` dumps **all 22 tables** (metadata, telemetry raw +
hourly rollups, alarms, users, audit log, notification config, orgs, API
keys, EMS schedules/plans, report schedules, OTA jobs — everything in
MySQL) to a timestamped directory of gzip'd JSONL files plus a
`manifest.json` (per-table row counts, column counts, creation timestamp).
Row identity (primary keys) is preserved, so a restore reproduces the exact
pre-loss state. (Until audit wave 3 the backup covered only the v7 15-table
list — the v8/v9 tables were added after the 2026-08-13 drill exposed the
gap; see Finding A in `docs/DRILL-EVIDENCE.md`.)

## Scheduled backups

```cron
# /etc/crontab — nightly at 02:15, keep 14 days
15 2 * * * root cd /opt/enertrek-cloud && npx tsx scripts/backup-db.ts /var/backups/enertrek >> /var/log/enertrek-backup.log 2>&1
20 2 * * * root find /var/backups/enertrek -maxdepth 1 -type d -mtime +14 -exec rm -rf {} +
```

Copy the backup directory off-box (object storage / second host) — a backup on
the same disk as the database is not a DR strategy.

## Restore (disaster recovery)

1. Provision a fresh MySQL/TiDB and apply the migrations (`db/migrations/*.sql`)
   — or reuse the existing server.
2. Verify the backup **before** touching anything:

   ```bash
   npx tsx scripts/restore-db.ts /var/backups/enertrek/<stamp> --verify
   # prints per-table counts; refuses incomplete/corrupt backups
   ```

3. Restore (DESTRUCTIVE — empties every table and replaces it with the backup):

   ```bash
   ALLOW_UNSAFE_PROD=1 npx tsx scripts/restore-db.ts /var/backups/enertrek/<stamp> --yes
   ```

   Both safeguards are mandatory on non-local databases: the
   `ALLOW_UNSAFE_PROD=1` environment opt-in and the `--yes` confirmation flag.

4. Restart the application. The ingestion WAL (`data/wal/`) replays any rows
   queued between the backup moment and the outage — at-least-once, so a few
   boundary duplicates are possible (telemetry has no unique constraint; they
   do not distort energy reports because those use counter deltas).

## Failure modes & notes

- **RPO** = backup interval (24 h with the cron above; lower it for stricter
  RPO). **RTO** = time to provision MySQL + restore (~minutes for typical
  fleets; telemetry volume dominates).
- Restoring kills active **sessions** (users log in again) and replays the
  escalation/maintenance state from the backup — expected.
- The restore aborts if the manifest disagrees with the file contents
  (truncated/corrupt backup) instead of writing partial state.
- Generated columns (`alarms.active_dedup_key`) are stripped on restore —
  MySQL recomputes them.
- Verified by `scripts/probe-v7-backup.ts` (canary loss → full recovery,
  guard refusal without opt-in, `--verify` consistency check) — re-run green
  on 2026-08-13 against the 22-table backup.
- Non-destructive drill: `scripts/dr/backup-restore-drill.ts` restores the 7
  audit tables (`users, sites, meters, gateways, ems_plans, api_keys,
  audit_log`) into a scratch database `volttrade_dr_drill` on the same
  server, compares row counts + per-table id checksums, and drops ONLY the
  scratch database. Requires `ALLOW_DR_DRILL=1`; if `CREATE DATABASE` is not
  permitted it falls back to backup-vs-live count/checksum verification and
  says so loudly. Last executed 2026-08-13 — PASS
  (`docs/DRILL-EVIDENCE.md`).
