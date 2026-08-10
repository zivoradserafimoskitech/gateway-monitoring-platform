# v7 — Acceptance criteria (12 points to professional grade)

Date: 2026-08-11 · Each criterion maps to one gap-analysis point. All probes
must pass live against the dev stack; unit tests must cover new pure logic.

## C1 — Auth + RBAC + audit log
- users/sessions/audit_log tables (migration applied); seeded admin (env-overridable).
- Login sets an httpOnly session cookie; logout revokes; `/api/trpc` mutations
  reject anonymous callers with UNAUTHORIZED; queries reject anonymous too.
- Roles admin/operator/viewer: viewer cannot mutate; operator cannot manage
  users/API keys; admin everything.
- Every successful mutation writes an audit row (user, procedure, payload digest).
- Frontend: login page, session persisted, 401 → login.
- Probes: anonymous mutation → 401; login → cookie; viewer mutation forbidden;
  audit row present after a create.

## C2 — Alarm notifications
- notification_channels (webhook/telegram/email) + alarm notification log table.
- On alarm activation → dispatch to all enabled channels (webhook+telegram live-probed
  with a local HTTP sink; email via SMTP config, gracefully skipped if unset).
- Escalation: unacknowledged alarm older than ESCALATE_MIN → re-dispatch to
  escalation targets (sweep probes).
- Maintenance window per site: alarms suppressed (evaluated but not notified/activated).

## C3 — TLS
- scripts/gen-dev-certs.sh creates self-signed certs; broker listens TLS on 8883
  when certs + env present; mqtts client probe connects.
- docs/tls.md + sample Caddyfile for HTTPS termination.

## C4 — Test connection at registration
- meters.testConnection: TCP device → real read of first profile registers,
  returns decoded values or a clear error; bus device → sendReadNow via gateway.
- UI: "Test" button in AddDeviceDialog showing values/error before save.
- Probe: test against sim 5021 unit 1 returns values; dead port returns clear error.

## C5 — Retention + downsampling
- telemetry_hourly table + migration; rollup job (avg/min/max per hour per meter),
  purge of raw rows older than TELEMETRY_RAW_DAYS (env, default 90);
  dailyReport reads hourly rows for days beyond retention.
- Probe: inject old rows → rollup → purge → old day still reports from hourly.

## C6 — Persisted queue (WAL)
- BatchWriter persists each flush batch to a WAL file before insert; deletes on
  success; on boot replays leftover WAL files.
- Probe: rows pushed, process killed before flush → next boot replays → rows in DB.

## C7 — Counter reset handling
- dailyReport energy deltas clamped at ≥0 per meter-day; day flagged
  `counterReset: true` when a decrease is detected; UI marks the cell.
- Probe: synthetic telemetry with a reset day → delta = post-reset only, flag set.

## C8 — Per-site timezones
- sites.timezone (IANA, default "UTC"); site-scope energy report buckets days in
  the site's local time (offset computed per day via Intl); UI select on site form.
- Probe: site at Europe/Skopje — daily totals differ from UTC bucketing when data
  straddles local midnight; UTC site unchanged.

## C9 — Observability
- GET /metrics (Prometheus text): mqtt messages, telemetry rows/failed/queue,
  poller polls/failures, active alarms, uptime.
- Request logging middleware with request id + duration (sampled in logs).
- Platform watchdog: poller with devices but 0 successes over 5 min or MQTT
  disconnected → platform alarm row (gatewayOffline-like, meterId null).
- Probe: /metrics returns series and values match stats; watchdog fires when sim down.

## C10 — Backup & DR
- scripts/backup-db.ts dumps all tables to timestamped gzip JSONL with manifest;
  scripts/restore-db.ts restores a backup file (ALLOW_UNSAFE_PROD guard);
  docs/runbook-backup-dr.md with schedule + restore drill steps.
- Probe: backup runs, manifest valid, file non-trivial, restore verified against
  a scratch table count.

## C11 — Public REST API + webhooks
- api_keys table (hashed keys, role scope, revoke); Hono routes:
  GET /api/v1/devices, /api/v1/devices/:id/latest, /api/v1/alarms, /api/v1/sites.
  Bearer key auth; 401 without key; docs/api-v1.md (+ JSON spec).
- Alarm webhook = notification channel type "webhook" (shared engine with C2).
- Probes: create key, curl endpoints, revoked key → 401.

## C12 — Active control
- device_profiles.controllable (json whitelist: key→{address,type,min,max,unit}).
- control.execute: admin/operator only; whitelist+range validated; FC6/FC16 write
  for TCP devices via poller connection, MQTT downlink frame for bus devices;
  commands row with user + result; audit log entry.
- UI: control panel on MeterDetail for whitelisted keys.
- Probe: simulator extended to accept FC6 writes; write setpoint → read back
  matches; out-of-range rejected; viewer rejected.

## C13 — Regression & delivery
- tsc clean; build ok; vitest all pass (incl. new tests); ESMU e2e 6/6;
  fleet online; run record; README index; plan closeout; version; archive;
  MK report.
