# v6 — Fixes (registration revision + MQTT option for PV/BESS)

Date: 2026-08-11 · Audit: `verifier/v6/registration-audit.md` (R1–R10)

## R1 (HIGH) — gateway uid charset — FIXED
- `gateways.create`: uid now `trim().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$/)`; `topicPrefix` regex `^[A-Za-z0-9_/-]*$`.
- Evidence: probes `gw uid with '/'`, `too short`, `with space`, `bad topicPrefix` all rejected with clear messages (probe-v6-registration.py 4/4).

## R2 (MED) — duplicate uid race — FIXED
- Insert wrapped: `isDuplicateKey(err)` → friendly "A gateway with this UID already exists".
- Evidence: probe `gw duplicate uid` → friendly error (not raw errno 1062).

## R3 (MED) — site deletion orphans — FIXED
- `sites.remove` now unbinds `gateways.site_id` and `meters.site_id` before delete; returns `{unboundGateways, unboundMeters}`.
- Evidence: probe `site remove unbinds` → `{unboundMeters: 1}`; meter survived with siteId null.

## R4 (HIGH) — meter model not validated — FIXED
- `meters.create`/`update`: model must exist in `device_profiles`, else `Unknown model "…" — it must match an existing device profile`.
- Evidence: probe `meter unknown model` (TYPO-3000) rejected; valid models unaffected (fleet 17/17 online).

## R5 (MED) — host format — FIXED
- `host` regex: IPv4 or DNS hostname, in create and update.
- Evidence: probe `meter bad host` ("not a host!!") rejected.

## R6 (LOW) — phases silent default — ACCEPTED (documented in audit)
- Profiles carry no phase metadata; `phases` is display-only. No functional impact.

## R7 (HIGH) — direct-TCP devices can't bind to a site — FIXED
- Schema: `meters.site_id` (nullable, indexed) — drizzle migration `0002_meter_site.sql`, applied live via `scripts/apply-meter-site-migration.ts` (idempotent).
- `meters.create`/`update` accept `siteId` (validated against sites); `meters.list` resolves `coalesce(meter site, gateway site)` via two aliased site joins; site-scope reports use `meters.site_id = X or gateways.site_id = X`.
- UI: site selector in AddDeviceDialog (both bus and TCP paths), i18n en+mk.
- Evidence: probe created "V6 Probe Site" + direct-TCP meter bound to it → `meters.list` returned `siteName: "V6 Probe Site"`; site delete unbound it (R3).

## R8 (HIGH) — G30 JSON dropped all PV/BESS telemetry — FIXED (the MQTT question)
- `normalizeValues(data, hints, extraKeys?)`: after the 14 alias metrics, passes through any numeric payload key declared in the meter's profile register map; open-key unit conversion (W-class hint + kW-class key name → /1000; Wh→kWh) via `normalizeOpenKey`; unknown keys still dropped (no wildcard ingestion).
- `handleG30Message` passes `map.map(d => d.key)` as extraKeys.
- Evidence: tests/normalize.test.ts +6 cases (25/25 total). Live probe `probe-v6-mqtt.ts`: huawei-sun2000 JSON uplink persisted `dcPowerKw 42.3, energyTotalKwh 15234.2, energyTodayKwh 210.5, internalTempC 41.2`; victron-gx persisted `socPercent 87.5, batteryPowerKw 2600W→2.6kW, chargeEnergyTotalKwh 987.6, dischargeEnergyTotalKwh 654.3, batteryVoltageV 52.1`; `rogueKey` dropped. ALL PASS.

## R9 (MED) — C30 ignored addressStride — FIXED
- `handleC30Frame` shifts the register map per unit (`unitId = meter.unitId ?? parsed.slave`, `shiftedAddress`) mirroring the poller.
- Evidence: `probe-v6-c30-stride.ts` — crafted FC4 frame from ESMU string bus unit 3 (block @3100) decoded with correct scales (`maxChargePowerKw 99.9`) and persisted. PASS.
- Probe lesson: bus addresses >255 overflow the 1-byte slave field — a stray auto-provisioned PEM3000 created during probe development was found and removed (id 1735002, telemetry cleaned).

## R10 (LOW) — auto-provision model/type guess — FIXED
- `ensureMeter` accepts any `modelGuess` present in `device_profiles` and takes `deviceType`/`brand` from the profile (`getProfileMeta()`); unknown guesses → PEM3000 + one-time console warning per model.
- Evidence: live probe — huawei-sun2000 auto-provisioned as `deviceType: inverter, brand: Huawei`; victron-gx as `bess`; `no-such-model` → PEM3000 + warning line in app log.

## Regression (B7)
- `npm run check` (tsc -b): clean.
- `npm run build`: OK.
- `npx vitest run`: 5 files / 25 tests, all pass.
- ESMU e2e (`scripts/test-esmu-e2e.ts`): 6/6 PASS (stack decode, per-unit stride, 2 alarms + auto-resolve, poller stability 0 failures).
- Fleet: 17/17 online (14 demo + 3 ESMU-T e2e rows); registration probe suite 13/13.

## Answer to the MQTT question
YES — after this revision PV plants and BESS can communicate via MQTT as a full option:
1. **G30 JSON uplink** — any device with a profile (inverter/BESS/weather) reports complete telemetry as JSON; open keys are normalized and persisted (R8); auto-provisioning sets the right type/brand (R10).
2. **C30 transparent Modbus-over-MQTT** — any profiled device incl. multi-unit ESMU strings (R9).
3. Registration guardrails (R1–R5) prevent the previously silent failure modes.
