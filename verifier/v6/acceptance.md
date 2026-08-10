# v6 acceptance — registration-flow revision + MQTT option for PV/BESS

Goal (user, MK): fully revise the registration process for plants, battery
systems, smart meters and gateways (no illogicalities/shortcomings), and
answer whether PV plants and battery systems can communicate via MQTT.

| # | Criterion | Method |
|---|-----------|--------|
| B1 | Registration audit document: every flow (site/plant, gateway, meter, direct-TCP PV/BESS, auto-provision) reviewed; each illogicality has file/line evidence + severity + disposition | `verifier/v6/registration-audit.md` |
| B2 | Gateway registration: uid charset validated (topic-safe), duplicate uid → friendly error, model/transport consistent | API probes |
| B3 | Meter registration: model must exist in device profiles (or explicit allow), host format validated, phases not silently wrong, no meaningless fields for TCP devices | API probes |
| B4 | Site/plant binding: direct-TCP devices (PV/BESS) can be assigned to a site; site reports include them; deleting a site handled | API probes |
| B5 | MQTT for PV/BESS: a device publishing JSON telemetry to the broker gets auto-provisioned AND its inverter/BESS keys (dcPowerKw, socPercent, …) persist — not just the 14 meter metrics | live probe with simulated inverter JSON uplink |
| B6 | C30 transparent path handles multi-unit devices (addressStride) consistently with the poller | unit test / code review |
| B7 | Regression: tsc, build, vitest 20+, ESMU e2e 6/6, fleet 14/14 | run |
| B8 | Run record, README index, version snapshot; final MK report answers the MQTT question explicitly | discipline |
