# v6 — Ревизија на процесот на регистрација (audit)

Date: 2026-08-11 · Scope: registration of sites, gateways, meters/PV inverters/BESS (UI + tRPC + MQTT auto-provisioning), and the question "can PV plants and battery systems communicate via MQTT as an option?".

Sources read: `api/routers/gateways.ts`, `api/routers/meters.ts`, `api/routers/profiles.ts` (sites + profiles), `api/routers/reports.ts`, `api/mqtt/handlers.ts` (ensureMeter, handleG30Message, handleC30Frame), `api/mqtt/service.ts`, `src/pages/Meters.tsx`, `src/pages/Gateways.tsx`, `db/schema.ts`, `contracts/modbus.ts`.

## Findings

### Gateway registration
- **R1 (HIGH)** — `gateways.create` validates uid only as `string.min(4).max(64)`. No charset rule: a uid containing `/`, `+`, `#`, space or UTF-8 breaks MQTT topic parsing (`uidFromAnyTopic` splits topics on `/`) and wildcard matching. A gateway registered with such a uid can never match its own uplink topics → silently no data. **Fix:** regex `^[A-Za-z0-9][A-Za-z0-9_-]{3,63}$` (topic-safe), trim; same charset check for `topicPrefix` segments.
- **R2 (MED)** — Duplicate uid: friendly pre-check exists, but the race path (two concurrent creates) surfaces a raw DB error (errno 1062) to the UI. **Fix:** catch `isDuplicateKey` on insert → friendly error.

### Site lifecycle
- **R3 (MED)** — `sites.remove` deletes the site row unconditionally; bound gateways keep an orphaned `site_id` (no FK). Site name silently disappears from lists; site reports keep "working" with stale ids. **Fix:** on delete, unbind (`site_id = null`) all bound gateways and meters; return the unbound count.

### Meter / PV-inverter / BESS registration
- **R4 (HIGH)** — `meters.create` does not validate `model` against `device_profiles`. A typo'd model is accepted, then the poller/MQTT path silently falls back to the PEM3000 default register map → wrong values persisted with no error anywhere. Profiles cannot be created via API (only `updateMap`), so arbitrary models are guaranteed-dead registrations. **Fix:** reject unknown models with a clear error (listing that the model must match an existing device profile).
- **R5 (MED)** — `host` is only `z.string().max(255)`. Garbage (`"abc def"`, `"http://x"`) is accepted and the poller then fails forever at runtime. **Fix:** IPv4 or DNS hostname regex.
- **R6 (LOW, accepted)** — `phases` silently defaults to `"three"` for non-Enertrek models; profiles carry no phase metadata. Cosmetic only (phases is display metadata, not used in decode). **Disposition:** documented, wontfix.
- **R7 (HIGH)** — Direct Modbus-TCP devices cannot be bound to a site/plant at all: `meters` has no `site_id` column, the AddDeviceDialog has no site selector, and site-scope reports/list joins resolve the site only via `gateways.site_id` (direct devices hang off the synthetic `direct-tcp` gateway whose site_id is null). Consequence: every PV plant / BESS registered via direct TCP is invisible in site reports and site lists. **Fix:** add `meters.site_id` (nullable) + migration; `meters.list`/`reports` resolve site as `coalesce(meters.site_id, gateways.site_id)`; site selector in AddDeviceDialog; unbind on site delete (R3).

### MQTT as an option for PV plants / BESS (the user's question)
- **R8 (HIGH)** — G30 JSON uplink persists ONLY the 14 meter metrics in `FIELD_ALIASES`. Inverter keys (`dcPowerKw`, `energyTotalKwh`, `efficiencyPercent`…), BESS keys (`socPercent`, `batteryPowerKw`, `chargeEnergyTotalKwh`…), weather keys — even when present in the JSON payload — are silently dropped (`normalizeValues` iterates only `FIELD_ALIASES`). So **today MQTT is not a usable option for PV/BESS telemetry** (registration via auto-provisioning works, but the telemetry is gutted). **Fix:** open-key passthrough — after alias mapping, pass through every numeric payload key that exists in the meter's profile `registerMap` (with unit-hint power normalization), so any provisioned device with a profile can report fully over MQTT JSON.
- **R9 (MED)** — C30 transparent frames ignore `addressStride`: the TCP poller shifts addresses per unit (`shiftedAddress`), the C30 path decodes at the raw span. Multi-unit devices (ESMU stack + string units 2/3) therefore decode only for unit 1 over C30. **Fix:** apply `shiftedAddress(map, unitId)` mirroring the poller before decode.
- **R10 (LOW)** — Auto-provisioned meters: model guess restricted to SEM2250/SEM3250/PEM3000 (anything else → PEM3000 silently) and `deviceType` hardcoded `"meter"`. A PV inverter or BESS publishing over MQTT would be auto-created with the wrong type/model. **Fix:** if `modelGuess` matches any model in `device_profiles`, use it and take `deviceType` from the profile; else fall back to PEM3000 + one-time warning log.

## Answer to the MQTT question (pre-fix state)
Partial: registration/auto-provisioning over MQTT works, C30 transparent Modbus-over-MQTT works for single-unit devices, but G30 JSON drops all PV/BESS-specific telemetry (R8) and C30 can't decode multi-unit devices (R9). After the R8/R9/R10 fixes: **yes — full MQTT option** (JSON uplink or transparent Modbus) for any device with a profile.

## Dispositions
R1 fix · R2 fix · R3 fix · R4 fix · R5 fix · R6 accepted/documented · R7 fix · R8 fix · R9 fix · R10 fix
