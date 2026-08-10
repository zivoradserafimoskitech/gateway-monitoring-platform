# v8 acceptance — EMS edition (points 12-depth + 13–20)

Scope: user selected ALL remaining gap-analysis points. One criterion set per
point; every run recorded in verifier/runs/; final regression = D10.

## D1 — Point 12 depth: automatic EMS strategies
- D1.1 `ems_schedules` table: BESS charge/discharge/idle windows (meterId,
  day-of-week mask, start/end time, mode, targetKw / targetSoc) + CRUD via
  tRPC (operator role) + audit.
- D1.2 `ems_peak_shaving` config per site (siteMeterId source, bessMeterId,
  thresholdKw, hysteresisKw, maxDischargeKw, enabled) + CRUD.
- D1.3 Controller loop (default 30 s tick, unref'd, started in boot): due
  schedule → executeAndLog via api/control/execute.ts (userId null = system);
  import > threshold → bounded discharge command; all commands land in
  `commands` with result; failures logged, never crash the loop.
- D1.4 UI: EMS panel on MeterDetail for BESS devices (schedule editor, peak-
  shaving config, recent auto-commands feed) EN/MK.
- D1.5 Probe (simulator): schedule covering "now" → command executed+logged;
  import spike → auto discharge command with result ok in `commands`.

## D2 — Point 13: multi-tenancy
- D2.1 `orgs` table + orgId on users, sites, gateways, meters, alarm rules,
  api keys, ems tables, ota jobs; migration backfills everything to
  "Default Org"; existing users become members of it; one superadmin
  (admin@enertrek.local) sees all orgs.
- D2.2 Session-scoped queries: non-superadmin users only see their org's
  sites/gateways/meters/alarms/reports/latestAll; mutations are org-checked.
- D2.3 tRPC: admin creates orgs + assigns users; login keeps working.
- D2.4 Probe: create org B + user B → user B sees only org B devices, cannot
  read/mutate org A; superadmin sees both.

## D3 — Point 15: scheduled reports
- D3.1 `report_schedules` (siteId, frequency daily|weekly|monthly, format
  xlsx|pdf, recipients json, hourLocal, enabled, lastRunAt) + CRUD (operator).
- D3.2 Scheduler loop: due schedule → generate report file from the existing
  report queries → deliver via C2 email channel (SMTP); lastRunAt updated;
  failure logged, loop survives.
- D3.3 UI on Reports page: schedule list + create/delete; EN/MK.
- D3.4 Probe: schedule with runNow → xlsx AND pdf generated, email transport
  invoked (log transport acceptable), row updated.

## D4 — Point 16: SCADA single-line diagram
- D4.1 Route /sites/:id/diagram (linked from Sites/Gateways UI + nav): SVG
  single-line — grid PCC → main meter → busbar → per-inverter and BESS
  branches with breakers; auto-layout from the site's devices.
- D4.2 Live values (10 s poll of latest telemetry): kW/kWh/SOC labels, power-
  flow arrows animate direction by sign, online/offline/alarm coloring.
- D4.3 EN/MK i18n; tsc clean; browser-verified rendering on the demo fleet.

## D5 — Point 17: device management
- D5.1 gateways: firmwareVersion + configVersion fields (shown in gateway UI).
- D5.2 `ota_jobs` (gatewayId, type firmware|config, payload json, status
  pending|sent|ack|failed, createdBy, timestamps) + tRPC CRUD (operator).
- D5.3 Delivery: MQTT gateways — publish cmd frame on the gateway topic
  (simulator acks); TCP devices — config push via C12 FC6 whitelisted keys;
  heartbeat diagnostics per gateway (last seen, msg/min, poller stats).
- D5.4 Probe: OTA job → simulator receives frame → ack → job status ack;
  diagnostics endpoint returns heartbeat data.

## D6 — Point 14: HA
- D6.1 External broker support: MQTT_URL env → app connects as MQTT client
  instead of starting the embedded broker; embedded stays the default.
- D6.2 /healthz + /readyz endpoints (DB ping + broker state) unauthenticated.
- D6.3 docker-compose.prod.yml: 2 app replicas behind nginx + 2-node EMQX
  cluster; docs/ha.md — zero-downtime rolling deploy procedure, state audit
  (what is in-memory vs DB), honest limits (single TiDB, privatelink).
- D6.4 Probe: boot with MQTT_URL against a second broker instance →
  telemetry flows; /healthz + /readyz return 200.

## D7 — Point 18: CI/CD quality gates
- D7.1 .github/workflows/ci.yml: install, tsc, vitest with coverage threshold,
  build, Playwright spec, npm audit --audit-level=high.
- D7.2 playwright.config.ts + tests/e2e/login.spec.ts (login → dashboard
  visible → viewer forbidden mutation).
- D7.3 vitest coverage config with thresholds; all existing tests still pass.
- D7.4 Playwright spec passes locally against the dev server.

## D8 — Point 19: protocol expansion
- D8.1 SunSpec profile pack: common header + models 103/111/120/123 as
  device profiles (scripts/seed-sunspec.ts); validate-profiles passes.
- D8.2 api/protocols/adapter.ts — protocol adapter interface (poll/decode/
  control) implemented by Modbus today, documented extension points.
- D8.3 docs/protocols.md — integration path for IEC 61850, DNP3, OCPP,
  M-Bus (architecture, effort, security notes). Honest: adapters themselves
  are separate projects.

## D9 — Point 20: operator documentation
- D9.1 docs/commissioning.md (site onboarding end-to-end),
  docs/runbook-operators.md (incidents: broker down, poller stall, DB
  unreachable, alarm flood), docs/sla.md (availability/support template),
  docs/architecture.md (system overview), docs/api-v1.md refreshed if
  endpoints changed.

## D10 — final regression + delivery
tsc, build, vitest (+coverage), ESMU e2e 6/6, all v1–v7 probes green, all
v8 probes green, fleet healthy, verifier records + README index, plan
closeout, version saved (dynamic), archive rsync, final report in Macedonian.
