# Plan — v3: ESMU (BAMS) Modbus TCP protocol integration

Source: `/mnt/agents/upload/ESMU_MODBUS_V2.1_EN.pdf` (vendor protocol doc, 49 pp).
ESMU = battery stack management unit (TCP server, port 502 default).
Two object types: **ESMU stack** (unit 1) and **ESBCM strings** (unit N+1 for string N,
input-register block base 100 + (N−1)×3000). Max 120 regs/read; 32-bit high-word-first.

## Stage 1 — Contract + codec extensions (needed by this protocol)
1. `contracts/modbus.ts`: add optional `offset?: number` to RegisterDef
   (decoded = raw×scale + offset) — required by current (−1600 A) and temperature
   (−40 °C) fields. Add optional `addressStride?: { firstUnit: number; stride: number }` —
   per-unit block shift for ESBCM string profiles.
2. `api/modbus.ts` `decodeRegisters`: apply offset.
3. `api/poller/service.ts`: shift map addresses by (unitId−firstUnit)×stride when
   unitId ≥ firstUnit, before buildBlocks.
4. `scripts/device-simulator.ts`: encode applies inverse offset; per-unit images
   apply the same stride shift (sim serves exactly what the poller decodes).
5. `scripts/validate-profiles.ts`: validate offset/stride fields.

## Stage 2 — Profiles (db/device-profile-library.ts, vendor source)
- `esmu-bams-stack` (brand ESMU, bess, tcp, vendor): FC4 input regs 1–50
  (stack V/I/SOC/SOH, cell extremes, energy counters, limits, state, insulation,
  comm-fault flags, time counters) + FC3 holding 500 (string count) + 530 (heartbeat).
- `esmu-bams-string`: FC4 regs 100–150 (string-1 block) with
  addressStride {firstUnit: 2, stride: 3000}.
- Canonical BESS keys where they exist (socPercent, batteryVoltageV, …) so UI tiles
  and alarm metrics work; ESMU-specific keys as open keys.
- Notes document: addresses as printed (decimal, treated as PDU), FC02 discrete
  alarm bits + FC06/10/41 control intentionally not mapped (monitoring-only
  integration; platform alarms derive from telemetry), no stack power register
  (P = V×I), state enum table.

## Stage 3 — Simulator physics
ESMU-aware values in device-simulator (HV ~768 V stack, ESMU-native status enum
1=charge/2=discharge/3=ready/8=fault, stringCount=2, heartbeat++, cell stats,
energy integration, per-string slight variations).

## Stage 4 — Verification (verifier/v3)
- `verifier/v3/acceptance.md`: E1 profile validation (30/30), E2 e2e telemetry
  stack+2 strings (offset/u32/stride decode), E3 string stride correctness
  (units 2,3 serve different blocks), E4 alarm on bmsStatusCode=8 + auto-resolve,
  E5 demo integration (stack + 2 strings online in app), E6 typecheck+build,
  E7 run records + version.
- `scripts/test-esmu-e2e.ts`: in-process sim (units 1,2,3 on test port) → poller →
  telemetry → alarm engine; writes verifier/runs/*-esmu-e2e.json.
- `npx tsx scripts/validate-profiles.ts`, `npm run check`.

## Stage 5 — Demo + delivery
- `scripts/provision-esmu-demo.ts` (idempotent) + standalone sim on port 5022
  (1 stack + 2 strings), verify online in app (verify-c9).
- seed-profiles.ts (insert new models), npm run build, version snapshot,
  rsync archive, verifier/README.md index update, final report.

# Plan — v4: principal-engineer review + security audit & remediation

## Stage 1 — Parallel review (2 subagents, read-only)
- Security auditor: static audit + live probes (SEC-01..SEC-10) vs localhost:3000 / 1883.
- Principal reviewer: architecture & logic illogicalities/shortcomings with file evidence.
- Orchestrator in parallel: npm audit, .env/gitignore, raw SQL grep, Dockerfile.

## Stage 2 — Triage & fix
- Fix CRITICAL/HIGH (and cheap MEDIUM) security findings; document accepted risks.
- Small high-value logic fixes only if clearly safe; bigger design issues go into report.

## Stage 3 — Verify & deliver
- Re-run failed security probes; regression (tsc, build, e2e, demo online).
- verifier/v4 reports + runs; README index; version; archive; final report (MK).

## v4 closeout (2026-08-10) — DONE
- Stage 1 (audit): security + engineering subagent reports → verifier/v4/*.md ✔
- Stage 2 (remediation): F-01..F-15 dispositioned; Eng #1/#4/#6/#15/#17 fixed;
  orphan data repaired (22,290 telemetry + 20 alarms + stray gateway);
  npm audit 21 → 6 moderate (dev-only) ✔
- Stage 3 (regression + delivery): tsc/build clean, probes pass
  (401/401/200, broker auth, 413), ESMU e2e 6/6, fleet 14/14, run record +
  README appended ✔ → version snapshot + archive

## v5 (2026-08-10) — resolve ALL remaining 19 engineering findings
- Stage 1: verifier/v5/acceptance.md (per-finding acceptance criteria)
- Stage 2 batch A (poller): #2 per-device offline threshold, #10 collateral socket kill, #11 getConn race, #12 error backoff
- Stage 3 batch B (data path): #3 batch writer retry/drain, #5 Timescale values_json parity, #7 alarm breach persistence, #14 alarms.counts SQL aggregate, #16 gwCache eviction
- Stage 4 batch C (contracts/UI/process): #8 UTC days, #9 unit metadata, #13 dashboard PRIMARY_POWER_KEY, #18 reports N+1, #19 alarm UI metrics from profile, #20 MeterDetail contract key, #21 derived labeling, #22 destructive-script DB guard, #23 unit tests, #24 drizzle migrations wiring
- Stage 5: regression (tsc/build/unit tests/e2e/fleet/security spot probes) + run records
- Stage 6: README index, version snapshot, archive, MK report

## v6 (2026-08-10) — registration-flow audit + MQTT option for PV/BESS
- Stage 1: audit registration UX/API for gateways, meters, plants (sites), BESS/PV → verifier/v6/registration-audit.md
- Stage 2: fix illogicalities (validation, duplicate errors, site binding for direct-TCP devices, uid charset, model/profile checks)
- Stage 3: MQTT option for PV/BESS — open-key G30 JSON path using profile maps + C30 addressStride symmetry; e2e probe with a simulated inverter publishing JSON
- Stage 4: tests/regression, run record, README, version, archive, MK report answering the MQTT question

### v6 closeout (2026-08-11)
- Stage 1 DONE: audit written — verifier/v6/registration-audit.md (R1–R10).
- Stage 2 DONE: R1–R5, R7 fixed (uid charset, duplicate race, site unbind,
  model-in-profiles, host regex, meters.site_id + migration 0002 + UI selector
  + list/reports coalesce). R6 accepted.
- Stage 3 DONE: R8 G30 open-key passthrough (PV/BESS full telemetry over MQTT
  JSON), R9 C30 addressStride symmetry, R10 profile-aware auto-provisioning.
  Live probes: registration 13/13, MQTT PV/BESS ALL PASS, C30 stride PASS.
- Stage 4 DONE: vitest 25/25, tsc clean, build OK, ESMU e2e 6/6, fleet 17/17;
  run record + fixes.md + README index; version + archive; MK report with
  explicit MQTT answer (YES — G30 JSON open keys or C30 transparent).

## v7 (2026-08-11) — 12 точки до екстремно професионално решение
Scope: points 1–12 from the gap analysis (А1–5, Б6–11, В12 active control).
Points 13–20 (enterprise tier) excluded by the user's "12 точки".

- Stage 0: verifier/v7/acceptance.md (C1–C12)
- Stage 1 (C1): auth + RBAC + audit log — users/sessions/audit tables, cookie
  sessions, role guards on mutations, login page, seed admin
- Stage 2 (C2): alarm notifications — channels (webhook/Telegram/email),
  dispatcher, escalation on unacked, maintenance windows
- Stage 3 (C4): test-connection at registration (endpoint + UI button)
- Stage 4 (C7): counter-reset handling in energy reports (non-negative deltas,
  flag + UI marker)
- Stage 5 (C8): per-site timezones in reports (IANA tz, local-day bucketing)
- Stage 6 (C5): retention + downsampling (telemetry_hourly rollup, purge job,
  report fallback for old days)
- Stage 7 (C6): persisted queue — WAL for the telemetry batch writer, replay
  on boot, crash probe
- Stage 8 (C9): observability — /metrics (Prometheus), request logging,
  platform watchdog alarm
- Stage 9 (C3): TLS — self-signed cert script, MQTT TLS listener (8883), HTTPS
  termination docs + sample Caddyfile
- Stage 10 (C10): backup/restore scripts + DR runbook
- Stage 11 (C11): public REST API /api/v1 with API keys + docs + alarm webhooks
- Stage 12 (C12): active control — whitelisted setpoints (FC6/FC16) for TCP
  devices + MQTT downlink, role-gated, audited, UI on MeterDetail, sim probe
- Stage 13: regression (tsc/build/vitest/e2e/fleet + all new probes), run
  record, README, version, archive, MK report

### v7 closeout (2026-08-11)
- Stage 0 DONE: verifier/v7/acceptance.md (C1–C13; C13 = final regression).
- Stage 1 (C1) DONE: users/sessions/audit, cookie login, RBAC guards, login
  UI, seeded admin/viewer; audit hardened with FAILED + DENIED rows.
- Stage 2 (C2) DONE: notify channels + dispatcher + escalation + maintenance
  windows; probes 5/5 + notify2 PASS.
- Stage 3 (C4) DONE: test-connection endpoint + UI button (part of v6-hardened
  registration; covered by registration probe 13/13).
- Stage 4 (C7) DONE: counter-reset non-negative deltas + flag; probe PASS.
- Stage 5 (C8) DONE: mysql2 TZ root cause — utcStr naive-UTC params +
  unix_timestamp epoch reads; probe 6/6.
- Stage 6 (C5) DONE: telemetry_hourly rollup + cutoff-split dailyReport +
  guarded purge loop; probe ALL PASS.
- Stage 7 (C6) DONE: WAL pending/rotate/replay, at-least-once; crash probe
  ALL PASS; hardened after tsx-corruption incident.
- Stage 8 (C9) DONE: /metrics + request-id + watchdog alarms; probe 6/6.
- Stage 9 (C3) DONE: TLS listener 8883 + dev certs + pinned-CA probe PASS;
  docs/tls.md.
- Stage 10 (C10) DONE: backup/restore/--verify + guards; probe ALL PASS;
  docs/runbook-backup-dr.md.
- Stage 11 (C11) DONE: /api/v1 + etk_ keys + admin key router; probe ALL PASS;
  docs/api-v1.md.
- Stage 12 (C12) DONE: controllable whitelist, FC6 write+readback, C30
  downlink, G30 reject, commands table, ControlPanel UI (EN/MK); probe 9/9.
- Stage 13 DONE: full regression battery ALL PASS (record
  verifier/runs/2026-08-11T06-20-00Z-v7-c13-regression.json), README index
  appended, version + archive + MK final report.

## v8 (2026-08-11) — EMS издание: точки 12-продлабочена + 13–20 (СИТЕ)
User request: implement everything remaining — 12-depth (auto peak shaving +
BESS schedule), 13 multi-tenancy, 14 HA, 15 scheduled reports, 16 single-line
diagram, 17 device mgmt/OTA, 18 CI/CD gates, 19 protocols, 20 operator docs.

- Stage 0: verifier/v8/acceptance.md (D1–D10)
- Wave 1 (parallel subagents, disjoint file ownership):
  - FE agent — D4/16: SCADA single-line diagram page (SVG, live values,
    flow direction, EN/MK i18n). Owns: src/pages/SiteDiagram.tsx,
    src/components/diagram/*, App.tsx routes, Layout nav, i18n en/mk.
    NO dev-server restart, NO api/ or db/ changes. Validate: tsc only.
  - DOCS agent — D8/19 SunSpec profile pack (definitions + seed script,
    NOT applied — orchestrator applies at gate) + api/protocols/adapter.ts
    skeleton + D9/20 operator docs (commissioning, runbook, SLA,
    architecture, protocols). Owns: docs/*, api/protocols/adapter.ts,
    scripts/seed-sunspec.ts, contracts additions only if needed.
  - BE agent (chain, sequential features) — D1/12-depth first: EMS tables
    (schedules, peak-shaving config), controller loop reusing
    api/control/execute.ts executeAndLog (userId null = system), EMS UI
    panel on MeterDetail. MAY restart dev server (only agent allowed).
    Then follow-up: D3/15 scheduled reports → D5/17 OTA → D2/13
    multi-tenancy → D6/14 HA code (external broker MQTT_URL, healthz).
    Owns: api/, db/, scripts/probe-v8-*.ts, migrations.
- Wave 2 (after backend chain lands): CI/CD agent — D7/18: GH Actions
  workflow, Playwright login spec (run locally), vitest coverage thresholds,
  npm audit gate. Owns: .github/, tests/e2e/, playwright.config.ts,
  vitest.config.ts.
- Stage 9 (D10): full regression battery + verifier run records per point +
  README index + plan closeout + website_version_manager (dynamic,
  /mnt/agents/output/app) + rsync archive + final report in Macedonian.

Integration gates (orchestrator-only): dev-server restarts between backend
features, migration application for D8 seed, probe execution, tsc/build.
Environment traps handed to every agent: run from /mnt/agents/output/app;
tRPC batch conventions (?batch=1, {"0":{"json":...}}); admin creds
admin@enertrek.local/admin1234; migration template scripts/apply-v7-notif-
migration.ts; utcStr for raw-sql Date params; unix_timestamp() reads; no
comments inside sql`` templates; TELEMETRY_WAL_DIR per-process for probes;
lazy API boot (curl /api/trpc/ping first); vite binds IPv6 localhost;
kill-by-port pattern (lsof -tiTCP:PORT) never pkill; sims on 5021/5022 and
broker on 1883 must stay alive; remote TiDB — destructive scripts need
ALLOW_UNSAFE_PROD=1; i18n keys in BOTH en.ts and mk.ts.

## v8 CLOSEOUT — 2026-08-11 (ALL DONE)

- D1 EMS strategies — DONE (probe 9/9, run record 07-50).
- D2 multi-tenancy — DONE (probe 9/9 + nested regressions, record 09-50).
- D3 scheduled reports — DONE (probe 6/6, record 08-50).
- D4 SCADA single-line diagram — DONE (record 07-15).
- D5 device management/OTA — DONE (probe 6/6, record 09-20).
- D6 HA — DONE (probe 5/5, record 22-50; external broker $share, healthz/
  readyz, compose 2-replica + EMQX cluster, replica-safe scheduler claim).
- D7 CI/CD — DONE (Playwright 4/4, coverage gate, audit allowlist, record 10-20).
- D8 protocol expansion + D9 operator docs — DONE (record 07-25).
- ERP integration (volttrade-erp) — DONE both sides (erp-sim 18/18, record 08-20).
- D10 final regression — DONE, ALL PASS (record 23-55): tsc/build/vitest 25/25,
  coverage gate, Playwright 4/4, ESMU e2e 6/6 ×2, every v1–v8 probe green,
  fleet healthy (0 null org_id, 17 meters streaming).
- Probe hardening (D10): rest-energy (a)/(b2), ems freshness filter, esmu-e2e
  org-stamp + cleanup — assertions only, product code untouched.
- Remaining delivery steps: final GitHub push (main), website_version_manager
  build_version, rsync archive → /mnt/agents/work/enertrek-cloud, final
  report in Macedonian. User-side: deploy ERP edge functions per
  docs/enertrek-integration.md; revoke the GitHub PAT used for the push.
