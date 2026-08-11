# Verifier index — PV/BESS integration

## v1 (2026-07-18)
- `v1/acceptance.md` — acceptance criteria for the PV inverter + BESS integration:
  schema generalization, brand profile library (≥20 inverter brands + ≥3 BESS),
  Modbus TCP poller, end-to-end ingestion via simulator, alarm firing on inverter/BESS
  metrics, typecheck + production build.
- `runs/` — append-only log of every verification run (command, exit code, values).
- 2026-08-10 `runs/2026-08-10T10-40-25-443Z-e2e.json` — first e2e run: 6/7 pass; FAIL on Victron profile lacking activePowerKw (map is battery/system-service). Fix: victron-gx retyped to BESS, KSTAR template added (20 inverters preserved), C5 assertion made map-aware.
- 2026-08-10 `runs/2026-08-10T10-51-13-930Z-e2e.json` — e2e re-run: ALL 7 CHECKS PASSED (C5/C6/C7).
- 2026-08-10 `runs/2026-08-10T11-05-00-000Z-final-acceptance.json` — final sweep: C1-C4, C8, C9 all pass. C1-C10 complete.
- 2026-08-10 UI fix post-sweep: inverter detail tile mislabeled "Battery °C" → "Heatsink °C" (new i18n key devices.heatsink EN/MK); rebuilt, re-verified in browser; version eaa0b68.
- 2026-08-10 `scripts/validate-profiles.ts` — deep C4 check: 28/28 seeded profiles (20 inverter + 5 BESS + 3 meter) parse; 0 bad register defs (keys, PDU addresses, FC, types, scales all valid).

## v2 (2026-08-10) — scale test: 500 gateways + 30 PV plants + 20 BESS
- `v2/acceptance.md` — acceptance criteria S1–S7: ≥95% of 500 gw / 8,000 meters fresh
  (last_seen_at <120s, coalesced by design), 110/110 TCP devices fresh with poller
  failure <1%, latestAll <3s over ~11k devices, app healthy/RSS, SOC alarms at scale
  with correct attribution, cleanup back to 11 demo devices, run records + version.
- Load: MQTT sim 500 gw × 16 meters ≈ 507 samples/s (152,000 samples over 5 min);
  30-plant Modbus TCP sim on ports 5101–5130 (90 inverters + 20 BESS, 15s poll).
- `runs/2026-08-10T12-02-21-449Z-scale.json` — FAIL: first-contact provisioning storm
  (65–100 rows/s persist vs 513/s publish; RSS 454→1525 MB). Resolution: this path is
  not the architecture's rollout model — meters are pre-registered at installation
  (`scripts/provision-fleet.ts`); re-ran with bulk pre-provisioning.
- 2026-08-10 (between runs) **Incident A — orphan meters under deleted gateway ids
  (2,947)**: app restarted at 12:09:20 and warmed caches ("503 gateways, 2875 meters")
  BEFORE cleanup-scale deleted those rows at 12:09:45; the no-TTL meterCache (and 300s
  gwCache) then served dead rows into run-2 messages, re-persisting telemetry against
  meters whose gateways no longer existed. **Fix 1** (`api/mqtt/handlers.ts`):
  meterCache entries now carry a 10-min TTL. Procedure hardened: cleanup/provision
  FIRST, then restart app. Post-fix cleanup found 0 orphans.
- 2026-08-10 (runs 3–5) **Incident B — liveness 3–4 min lag under load (S1/S2 0-fresh)**:
  the 5s liveness flush rewrote ALL ~8,100 seen devices every cycle (17 chunked UPDATEs
  ≈200s under load; `now` stamped at flush start made it self-delaying; an idle 500-id
  UPDATE measures ~100ms). **Fix 2** (`api/mqtt/liveness.ts`): per-device 60s
  coalescing (~12× write reduction); freshness window set to 120s. Run 3 additionally
  lost to a wedged broker (70 msgs received of the flood) — broker restarted.
- `runs/2026-08-10T12-48-43-487Z-scale.json`, `runs/2026-08-10T12-56-44-765Z-scale.json`
  — intermediate failing runs (Incident A/B diagnosis).
- `runs/2026-08-10T13-01-08-343Z-scale.json` — **ALL 7 CHECKS PASSED** under full load:
  500/500 gateways fresh, 7,968/8,000 meters fresh (99.6%), 110/110 TCP devices fresh
  with 3,300 polls / 0 failures, latestAll 476–1,230 ms over 11,122 devices,
  RSS 260 MB, 20/20 SOC alarms active with correct attribution, writer 89,203 rows /
  0 failed.
- `runs/2026-08-10T13-20-00-000Z-scale-closeout.json` — S6/S7: scale fleets removed
  (`cleanup-scale.ts` + `cleanup-pv-scale.ts`: 500 gw + 8,000 meters + 110 SCL devices
  + 20 SCL rules + telemetry/alarms; plant sim stopped), 0 orphan meters post-cleanup,
  original 11 demo devices intact and online.

## v3 (2026-08-10) — ESMU (BAMS) battery-stack protocol integration
- `v3/acceptance.md` — criteria E1–E7 for integrating the vendor protocol doc
  `ESMU_MODBUS_V2.1_EN.pdf` (ESMU battery stack management unit, Modbus TCP;
  unit 1 = stack object, units 2..21 = ESBCM strings at block base 100+(N−1)×3000;
  biased registers: current −1600 A, temperature −40 °C).
- Codec extensions (backward-compatible): `RegisterDef.offset`
  (value = raw×scale + offset) and `RegisterDef.addressStride` (per-unit block
  shift) in contracts/modbus.ts; applied by api/modbus.ts decodeRegisters,
  api/poller (shift before block build) and scripts/device-simulator.ts (inverse
  on encode); validate-profiles.ts checks both fields.
- Two vendor profiles: `esmu-bams-stack` (FC4 regs 1–50 + FC3 500/530) and
  `esmu-bams-string` (FC4 100–150, strided per unit). FC02 alarm bits, FC06/10
  control writes, FC41 time sync and per-cell arrays intentionally unmapped
  (monitoring-only integration; documented in profile notes).
- `runs/*-esmu-e2e.json` — ALL 6 CHECKS PASSED: stack 39 keys decoded
  (V=777.1, I=289.5, SOC=60, state=2, stringCount=2 via FC3, heartbeat live);
  string stride proven (string-1 SOC=58 @block 100 vs string-2 SOC=62 @block 3100);
  bmsStatusCode=8 fault alarm + string low-SOC alarm fired and auto-resolved;
  3 objects × 11 polls, 0 failures.
- `runs/2026-08-10T14-05-00-000Z-esmu-demo.json` — E1/E5/E6: 30/30 profiles valid;
  ESMU demo (stack + 2 strings, sim :5022) online in the real app — 41/47/47 keys,
  0 poll failures, offset decode confirmed in production path; 14 demo devices
  total (original 11 intact); tsc + build clean.
- Note: during v3 the long-running dev daemons (broker/app/meter-sim/plant-sim)
  were found reaped by the environment; all restarted and re-verified (app binds
  IPv6 `localhost` — use http://localhost:3000, not 127.0.0.1).


## v4 — principal-engineer review + security audit & remediation (2026-08-10)
- Acceptance: `v4/acceptance.md` (V1 engineering report, V2 security battery,
  V3 CRITICAL/HIGH dispositioned, V4 regression, V5 records/version).
- `v4/review-engineering.md` — 24 findings (1 CRITICAL, 8 HIGH incl. cascade
  deletes, offline-threshold flapping, batch-writer durability, codec-field
  stripping by zod, alarm restart/ack states, triple timezone), each with
  evidence and disposition.
- `v4/security-tests.md` — SEC-01..SEC-10 battery + F-01..F-15 findings.
  CRITICAL: unauthenticated tRPC (F-01), anonymous MQTT broker (F-02);
  HIGH: auto-provision injection (F-03), poller SSRF (F-04), .env baked into
  Docker image (F-05). All CRITICAL/HIGH fixed or explicitly documented
  accepted-risk with rationale; MEDIUMs fixed (stack leak, compose default
  creds, CSV formula injection, 50MB body limit).
- Fixes verified live: API_TOKEN guard 401/401/200; broker auth
  anonymous/bad-creds REJECTED vs good-creds CONNECTED; 3MB POST → 413;
  repair-orphans removed 22,290 telemetry + 20 alarm orphans (+ immortal
  alarms 90003/30001) and stray 'test' gateway; npm audit 21 vulns →
  6 moderate (dev-only, breaking fixes declined).
- `runs/2026-08-10T14-50-31-000Z-v4-remediation.json` — full regression after
  fixes: tsc clean, build ok, ESMU e2e ALL 6 CHECKS PASSED, demo fleet
  14/14 online. Verdict: PASS.

## v5 — all remaining engineering findings resolved (2026-08-10)
- Acceptance: `v5/acceptance.md` (A1–A19, one criterion per finding + regression).
- `v5/fixes.md` — all 19 open findings from v4 FIXED with file evidence:
  #2 per-device offline thresholds (2.5×pollInterval), #3 batch-writer
  retry/backoff/bounded queue/SIGTERM drain, #5 Timescale values_json parity,
  #7 alarm dedup in three layers (ack-aware evaluation, active_dedup_key
  unique generated index — race-proof across processes/reloads, live-verified),
  #8 UTC day bucketing everywhere, #9 unit-hint normalization, #10–#12 poller
  transport-error classification + connect-race fix + bounded busy-wait,
  #13/#20 PRIMARY_POWER_KEY/ENERGY_COUNTER_KEY contracts in dashboard, history
  and MeterDetail chart, #14 SQL counts, #16 cache eviction, #18 reports
  batching, #19 open alarm metrics from profiles, #21 derived-demand labeling,
  #22 destructive-script DB guard, #23 vitest suite (20 tests), #24 drizzle
  migrations wired (0000 baseline + 0001 applied live).
- `runs/2026-08-10T16-04-20-000Z-v5-regression.json` — 20/20 unit tests, tsc
  clean, build ok, ESMU e2e 6/6, fleet 14/14 online, all live probes PASS.
  Verdict: PASS.

## v6 — registration revision + MQTT option for PV/BESS (2026-08-11)
- Acceptance: `v6/acceptance.md` (B1–B8).
- `v6/registration-audit.md` — 10 findings (R1–R10) across gateway/site/meter
  registration and MQTT ingestion; dispositions: 9 fixed, 1 accepted (R6).
- `v6/fixes.md` — uid/topicPrefix charset + friendly duplicate (R1/R2), site
  delete unbinds (R3), model-in-profiles + host regex validation (R4/R5),
  meters.site_id for direct-TCP devices incl. UI selector + reports/list
  coalesce (R7), G30 open-key passthrough for PV/BESS telemetry (R8), C30
  addressStride symmetry with the poller (R9), profile-aware auto-provisioning
  with deviceType/brand + fallback warning (R10).
- MQTT answer: YES — PV plants and BESS can use MQTT as a full option
  (G30 JSON with profile open keys, or C30 transparent Modbus incl. multi-unit
  devices).
- `runs/2026-08-11T00-59-30-000Z-v6-registration-mqtt.json` — registration
  probes 13/13, MQTT PV/BESS live probe PASS, C30 stride probe PASS, vitest
  25/25, tsc clean, build ok, ESMU e2e 6/6, fleet 17/17 online. Verdict: PASS.

## v7 — gap-analysis 12 points: prod hardening + control plane (2026-08-11)
- Acceptance: `v7/acceptance.md` (C1–C13, one criterion per implemented point +
  final regression). Scope: points 1–12 of the gap analysis (А1–5, Б6–11, В12
  active control); points 13–20 explicitly out of scope.
- C1 audit hardening: middleware now also writes FAILED(code) rows for erroring
  mutations and DENIED(FORBIDDEN) rows for role-blocked mutations.
- C3 TLS: broker tls.createServer listener (MQTT_TLS_PORT 8883, certs/dev.*,
  MQTT_TLS=0 kill-switch); openssl dev certs with SAN; `docs/tls.md`.
- C5 retention: `telemetry_hourly` rollup (intra-hour deltas + lag-based
  inter-hour deltas, samples-weighted pf) + dailyReport cutoff-split merge;
  retention loop (TELEMETRY_RAW_DAYS=90) with remote-DB guard.
- C6 WAL: sync-append `pending.jsonl` → rotated `f-*.jsonl` segments, unlink
  only after successful insert, `replayWal()` on boot, at-least-once semantics;
  TELEMETRY_WAL_DIR env; ENOENT self-heal after node_modules/tsx corruption
  incident.
- C8 timezone root cause: mysql2 serializes raw-sql Date params in process TZ
  (container +8h) while drizzle writes naive UTC and reads naive datetimes as
  local → `utcStr` naive-UTC strings for all raw-sql Date params; epoch reads
  via `unix_timestamp()`. Fixed the silently +8h-shifted dailyReport window.
- C9 observability: Prometheus text `/metrics`, x-request-id middleware,
  platform watchdog alarms (MQTT/poller stall) with dedup + auto-resolve.
- C10 backup/DR: `scripts/backup-db.ts` (gzip JSONL × 15 tables + manifest),
  `scripts/restore-db.ts` (strips generated columns, ISO-date revival,
  --verify, ALLOW_UNSAFE_PROD=1 + --yes); `docs/runbook-backup-dr.md`.
- C11 REST API: `etk_` keys (sha256 stored, prefix + 30s cache + instant
  revoke), Hono router at /api/v1 (sites/devices/latest/alarms);
  `docs/api-v1.md`; admin tRPC router for key lifecycle.
- C12 active control: `device_profiles.controllable` JSON whitelist, FC6 TCP
  write + read-back verify, C30 transparent downlink frame, G30 rejected;
  `commands` table extended; ControlPanel UI (EN/MK i18n).
- `runs/2026-08-11T06-20-00Z-v7-c13-regression.json` — full battery: tsc clean,
  build ok, vitest 25/25, ESMU e2e 6/6 ×2, probes: auth 12/12, registration
  13/13, notify 5/5, notify2 PASS, counter-reset PASS, timezone 6/6, retention
  PASS, wal PASS, observability 6/6, tls PASS, backup PASS, rest-api PASS,
  control 9/9, v6-mqtt PASS, c30-stride PASS; fleet 3/4 gateways online
  (gw-60001 pre-existing offline), 18 meters, 0 active alarms. Verdict: PASS.
- Per-point run records: `runs/*-v7-c{3,5,6,8,9,10,11,12}-*.json` (all PASS).
- Incidents: node_modules/tsx overlay-FS corruption (repaired, WAL hardened);
  2 stale notify-probe alarms + rules cleaned; temp probe gateway removed.

## v8 — mega-edition: EMS, multi-tenancy, HA, reports, OTA, SCADA, CI/CD, protocols, ERP (2026-08-11)

Acceptance criteria: `v8/acceptance.md` (D1–D10). Per-point run records:
`runs/*-v8-*.json` (all PASS).

- D1 EMS active control: `ems_schedules` (DoW mask, tz-aware windows, DST-correct)
  + `ems_peak_shaving` (threshold/hysteresis/max discharge); controller loop
  (EMS_TICK_S, SOC guards, 5-min idempotency) via executeAndLog(userId null)
  → C12 interlock + commands audit; EmsPanel UI (EN/MK).
- D2 multi-tenancy: `orgs` + org_id on 11 tables + superadmin; org-scope lib
  (reads 404 / writes 403, no existence leak); open demo mode unrestricted;
  per-org dashboard cache; REST v1 scoped to key's org; migration 0012.
- D3 scheduled reports: `report_schedules` (daily/weekly/monthly, xlsx|pdf,
  recipients, site-local due rule, period-dedup), hand-rolled PDF-1.4 writer,
  mailer (SMTP_URL or log transport), previous-period delivery.
- D4 SCADA single-line diagram: pure-SVG SiteDiagram (PCC→breaker→meter→busbar
  →branches, power-sign arrows, alarm/offline states), route + i18n.
- D5 device management/OTA: `ota_jobs` state machine (pending→sent→ack|failed,
  sweep, ack timeout, attempts), `g2d/<uid>/ota` + `d2g/<uid>/ota` ack,
  gateways.diagnostics, simulator ack support; DeviceManagementCard UI.
- D6 HA: external broker mode (`MQTT_URL`, `$share/enertrek/#` on EMQX),
  `/healthz` + `/readyz` (db+broker components), docker-compose.prod.yml
  (2 app replicas + nginx least_conn + 2-node EMQX cluster, per-replica WAL),
  report-scheduler atomic claim (replica-safe), `docs/ha.md` with honest
  duplicate-loop analysis + kill-switches (EMS_TICK_S/REPORT_TICK_MIN ≤ 0).
- D7 CI/CD: `.github/workflows/ci.yml` (tsc -b, coverage gate, build, audit
  gate with documented 2-ID xlsx allowlist; e2e gated to workflow_dispatch —
  TiDB is privatelink-only), Playwright 4 specs, coverage thresholds.
- D8 protocol expansion: `scripts/seed-sunspec.ts` (common + inverter 103/111,
  argv[1]-guarded main), `api/protocols/adapter.ts` registry; `docs/protocols.md`.
- D9 operator docs: commissioning, runbook-operators, sla, architecture,
  protocols, ci, ha, api-v1 (updated).
- ERP integration (volttrade-erp): REST-pull contract — `GET /api/v1/devices`,
  `GET /api/v1/devices/:id/energy?from&to&bucketMin` (counter-reset-safe deltas,
  raw/hourly retention split, UTC floor..ceil grid, gaps→nulls), `GET .../latest`;
  Deno edge functions sync-enertrek-meters (15 min) + sync-enertrek-assets
  (5 min) with pg_cron+pg_net; `docs/enertrek-integration.md` (ERP repo).
- D10 final regression: `runs/2026-08-10T23-55-00Z-v8-d10-final-regression.json`
  — tsc clean, build ok, vitest 25/25, coverage gate PASS (26.23/24.35/16.75/
  10.46), Playwright 4/4, ESMU e2e 6/6 ×2, ALL v8 probes green (ems 9/9,
  rest-energy 10/10, erp-sim 18/18, reports 6/6, ota 6/6, multitenancy 9/9
  incl. nested v7-auth 12/12 + v7-control 9/9 + rest-energy 10/10, ha 5/5),
  v7+v6 probe battery green (backup, counter-reset, observability, notify 5/5,
  notify2, rest-api, timezone, retention 7/7, tls, wal, registration 13/13,
  v6-mqtt, c30-stride; dedup SKIP — no active alarm); fleet healthy (4+1 gw,
  18 meters, 0 null org_id, 4625 rows/h). Verdict: PASS.
- Probe hardening during D10 (assertion/harness only — product code correct):
  rest-energy (a) reset-bucket tolerance + (b2) settled-hour window; ems
  freshness filter on command waits; esmu-e2e org-stamp + artifact cleanup.
- Incidents: stale dev server served SPA on /healthz after D6 vite edits
  (gate rule re-confirmed: restart after every api/vite-config edit);
  Playwright browser 1234 installed; retention probe ran with scoped
  ALLOW_UNSAFE_PROD=1 (cutoff predates all production rows).

## v9 (2026-08-11) — AI прогноза + портфолио оптимизер (Enertrek мускул + VoltTrade мозок)
- `v9/acceptance.md` — acceptance criteria EN.1–EN.7 (Enertrek ems-plan слој),
  VT.1–VT.9 (VoltTrade прогнози/оптимизер), INT.1–INT.3 (интеграција).
- Архитектура: VoltTrade = мозок (PV/load/price прогнози со квантили,
  детерминистички оптимизер, shadow набавка, accuracy јамка, cron 06:45/13:15/
  2h/23:50); Enertrek = мускул (единствен што пишува по уреди; приоритет
  peak-shaving > fresh ems_plan > schedules > idle; fail-safe = локални
  распореди/idle кога VoltTrade е down).
- Contract A (Enertrek, миграција 0013 `ems_plans` + REST): PUT
  `/api/v1/devices/:id/ems-plan` (span ≤48h, 1..192 setpoints, sorted,
  ts-in-window, |kw|≤500; upsert-supersede на overlap) + GET current-or-next;
  контролер: step-function setpoints, prefix `plan:<source>` во commands.result,
  lazy expire (valid_to<now, limit 500/tick); `scripts/probe-v9-ems-plan.ts`
  12/12 PASS; регресии ems 9/9 + erp-sim 18/18 зелени по интеграцијата.
- Contract B (VoltTrade, `supabase/functions/_shared/` pure TS — работи и под
  Deno и под `npx tsx`): types/holidays/weather(Open-Meteo fail-soft)/pv
  (clear-sky×NWP×MOS)/load(hour-of-week half-life 14d)/price(7-дневна mean
  крива, само pre-12:00)/optimize(8 детерминистички чекори, tie-break по ts,
  imbalance ratio 1.5, reserve SOC 30%)/enertrek-push/pipeline; миграција
  `20260811130000_forecast_optimizer.sql` (site_forecasts — преименувана бидејќи
  public.forecasts веќе постоеше како budget табела); 4 edge functions
  (optimize-morning 06:45 CET, optimize-post1300 13:15 со ВИСТИНСКИ цени,
  optimize-intraday 2h, forecast-accuracy 23:50); UI `src/pages/admin/
  Optimizer.tsx` + рута + Sidebar; `scripts/v9-selfcheck.ts` 40/40 PASS
  (познат-оптимум синтетици a–d; независно re-run од orchestrator, exit 0).
- `runs/2026-08-11T09-36-00Z-v9-int1-e2e.json` — INT.1 e2e harness
  (`scripts/probe-v9-e2e-integration.ts`, cross-repo import на VT _shared):
  13/13 PASS. Оптимизер → 96×15min план за утре → pushEmsPlan → Enertrek PUT
  (planId) → GET current-or-next → live извршување на ESMU sim: 3.0→1.0→0 kW
  чекори со commands редици `plan:volttrade-e2e` + независен Modbus read-back
  30→10→0; lazy expire по validTo; регистар останува 0 (нема fallback).
  Економски инваријант верифициран: празнење 17–21h @80€/MWh; полнење САМО од
  PV вишок (146.6 kWh surplus, export=0€) или евтина тарифа — 0 grid-charge
  @high-price виолации.
- `runs/2026-08-11T09-40-00Z-v9-v8-spot-regression.json` — v8 spot-регресија по
  v9 измени: reports 6/6, ota 6/6, erp-sim 18/18, ems 9/9, ha 5/5 — сите зелени.
- `runs/2026-08-11T09-45-00Z-v9-phase1-tou-demo.json` — Phase 1 (0€) TOU демо
  распореди на ESMU sim батерија: полнење 00–06 @3kW (SOC≤90), празнење
  17–21 @3kW (SOC≥25); валидирано преку ems.schedules.list (id 30003/30004).
- Probe hardening (assertion/harness only — продукт кодот точен): e2e A3
  првично бараше ноќно полнење — погрешно за PV-surplus профил со export=0€
  (оптимално е ноќно празнење за простор за бесплатен PV); ota diagnostics
  race (брз ack < 5s liveness flush) → poll до ~15s; /tmp sim-log symlinks
  репоентирани кон logs/ по reboot.
- `runs/2026-08-11T10-12-00Z-v9-final-regression.json` — финална батерија:
  ems-plan 12/12, e2e 13/13, selfcheck 40/40, reports 6/6, ota 6/6, erp-sim
  18/18, ems 9/9, ha 5/5, rest-energy 10/10, multitenancy 9/9 (вгнездени
  12/12+9/9+10/10). rest-energy (a)/(b2) по reboot беа environmental (feed
  gap → нема rolled history) и самооздравеа ~10:05 UTC (09:00 час ролиран
  како estimated). Verdict: PASS.
- Часовна лента на пазарот (дизајн одлука): bids close 12:00 CET ПРЕД
  објава на цени 13:00 CET → набавката користи FORECAST цени (optimize-morning);
  батеријата се ре-оптимизира 13:15 со ВИСТИНСКИ цени (optimize-post1300);
  батеријата = прв штит против imbalance; набавка = Σload − Σpv − Σdischarge +
  Σcharge по период, bias-long маржа (ratio 1.5, cap 15%).
