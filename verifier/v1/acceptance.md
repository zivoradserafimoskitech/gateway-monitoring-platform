# Acceptance criteria v1 — PV/BESS integration

All checks run from /mnt/agents/output/app unless noted.

| # | Criterion | How verified |
|---|-----------|--------------|
| C1 | `npm run check` exits 0 | run |
| C2 | `npm run build` exits 0 | run |
| C3 | DB migration applied: meters.model is varchar, meters has device_type/brand/host/port/unit_id/poll_interval_sec, telemetry has values_json, device_profiles has brand/device_type/protocol/source/fault_codes | verifier script queries information_schema |
| C4 | Profile library seeded: ≥20 inverter-brand profiles + ≥3 BESS profiles + 3 meter profiles; every profile's register map parses and every register key is a non-empty string; addresses fit their protocol range | verifier script queries DB |
| C5 | E2E ingestion: PV simulator (≥6 inverters across ≥3 brands + ≥2 BESS on Modbus TCP) + poller → after 90s, telemetry rows exist for every simulated device, `latest` returns inverter keys (dcPowerKw/dcVoltageMppt*) and BESS keys (socPercent) with physically sane values | scripts/test-pv-e2e.ts |
| C6 | Alarm engine works on new device metrics: rule on socPercent (lt) and on faultCode (gt) fires when simulator injects fault / low SOC, and resolves when condition clears | inside test-pv-e2e.ts |
| C7 | Fleet queries still healthy with mixed fleet: latestAll latency < 2s | inside test-pv-e2e.ts |
| C8 | UI exposes device types: devices list has type filter, device detail renders inverter/BESS sections (grep built bundle for markers, plus typecheck) | grep dist + check |
| C9 | Existing meter functionality unbroken: demo meters still online with fresh telemetry after all changes | API query in test script |
| C10 | website_version_manager build_version saved; archive rsynced | tool result |
