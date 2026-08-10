# Acceptance criteria v2 — mixed-fleet scale test

Scale scenario (all concurrent, one app instance):
- 500 MQTT gateways × up to 16 meters each (existing scale simulator, UIDs 170*/860*)
- 30 small PV plants = 30 Modbus TCP servers (ports 5101–5130), 3 inverters each = 90 inverters, rotating across the 18 researched inverter profiles
- 20 BESS storages co-located at plants 1–20 (unit id 4), rotating across Victron/BYD/Pylontech maps
- ~8,100 devices total ingesting simultaneously

| # | Criterion | How verified |
|---|-----------|--------------|
| S1 | MQTT path: ≥95% of the 500 scale gateways have fresh liveness (last_seen_at age < 120 s; liveness coalesced to ~60 s/device by design) during steady state | scripts/verify-scale.ts queries DB |
| S2 | TCP path: 100% of the 110 PV/BESS scale devices have fresh liveness (<120 s); poller failure rate < 1% of polls | verify-scale.ts + getPollerStatus |
| S3 | Fleet query at full scale: latestAll over ~8,100 devices < 3 s (3 samples) | verify-scale.ts |
| S4 | Ingestion sustains load: app process alive, MQTT connected, no poller crash, RSS growth < 30% over the run | verify-scale.ts samples + ps |
| S5 | Alarm engine at scale: SOC rule across all scale BESS fires for those below threshold with correct device attribution | verify-scale.ts |
| S6 | Cleanup: scale fleet (gateways/meters/telemetry/alarms + TCP devices + test rules) removed; original 11 demo devices intact and online | cleanup scripts + verify-scale.ts --post-cleanup |
| S7 | Evidence logged: verifier/runs/<ts>-scale.json + README index updated; version saved | file check |
