# Protocol integration guide (D8)

How new device protocols plug into Enertrek Cloud. The extension point is
`api/protocols/adapter.ts` (`ProtocolAdapter` interface + registry); the two
existing Modbus paths predate it and are **not** refactored — the registered
`modbus` adapter simply delegates to them.

## What ships today

| Path | Transport | Code |
|---|---|---|
| G30 gateway → MQTT JSON | mqtt/mqtts, topics `{prefix}/{uid}` | `api/mqtt/service.ts`, `handleG30Message` |
| C30 gateway → transparent Modbus RTU | raw RTU frames inside `d2g/{uid}` / `g2d/{uid}` | `api/mqtt/handlers.ts`, `api/modbus.ts` |
| Modbus TCP poller (direct devices) | TCP :502, unit-id per device | `api/poller/service.ts` |
| Control (FC6 setpoints) | direct TCP write + read-back, or C30 downlink | `api/control/execute.ts` |

All paths converge on `persistTelemetry` (api/mqtt/handlers.ts) → WAL batch
writer → store, with liveness tracking and alarm rules applied uniformly.
**Any new protocol must converge on the same function** — that is what makes
retention, rollups, alarms, reports and the UI work unchanged.

## What an adapter must implement

```ts
interface ProtocolAdapter {
  protocol: string;                    // registry key
  capabilities: { poll; control; discovery? };
  decode(map, data, baseAddress);      // raw bytes → canonical metric keys
  poll?(meter);                        // optional: full poll loop for non-Modbus
  control?(meter, key, value);         // must keep whitelist/range/audit discipline
}
```

Integration points:

1. **Ingest** — either a poll loop (started next to `startPollerService()` in
   `api/boot.ts`) or a listener (MQTT/serial/TCP server). Decoded values go to
   `persistTelemetry(meter, values, raw)`.
2. **Register maps / profiles** — reuse `device_profiles` rows
   (`scripts/seed-profiles.ts`, `scripts/seed-sunspec.ts` are the pattern) or
   add a protocol-specific mapping table if RegisterDef cannot express the
   addressing.
3. **Control** — declare writable points in `device_profiles.controllable`
   (same whitelist shape as `api/control/execute.ts`); reuse `executeControl`
   where possible so RBAC (operator/admin), range clamps, read-back and the
   `commands` audit trail come for free.
4. **Observability** — expose status getters so the watchdog
   (`api/lib/observability.ts`) can raise a platform alarm when your ingest
   path stalls; add Prometheus counters alongside the existing
   `enertrek_*` metrics.

## Per-protocol assessments

> Honest scope note: each of these is a **separate integration project**, not
> a config change. Estimates assume a senior engineer with protocol experience
> and test hardware, and cover adapter + profiles + e2e probe, not vendor
> certification.

### IEC 61850 (utility substation)

- **Shape:** client (ICD/SCD-configured MMS over TCP :102) polling logical
  nodes (MMXU, MMTN, ZBAT...) and mapping data attributes to canonical keys.
  GOOSE/SV are out of scope for monitoring.
- **Plug-in:** new poll loop (like `api/poller/service.ts`), one MMS
  association per IED; decode → `persistTelemetry`. Control via controllable
  whitelist → MMS write/operate (with select-before-operate where required).
- **RegisterDef fit:** poor (object models, not registers) — needs a small
  per-profile point list; store as JSON in the profile `notes`/`registerMap`
  extension or a new column.
- **Effort:** 6–10 weeks (library e.g. libiec61850 bindings or a TS MMS
  stack; SCD parsing; per-IED type testing).
- **Security:** no encryption in baseline MMS — segment the substation VLAN,
  jump-host the platform, or require IEC 62351 TLS where the IEDs support it.
  Role-based access at the IED; treat control as privileged and audited.

### DNP3 (utility SCADA)

- **Shape:** outstation is the field device; platform acts as DNP3 master
  (TCP :20000). Poll analog/binary inputs (classes 1/2/3 or integrity),
  map to metric keys; control via CROB/analog output operates.
- **Plug-in:** master poll loop feeding `persistTelemetry`; control through
  the whitelist with direct-operate (and read-back via class-0 poll).
- **Effort:** 4–8 weeks (mature master libraries exist in C++/Java; TS
  options are thin — budget for bindings).
- **Security:** DNP3 Secure Authentication v5 (challenge-response) where
  supported; TLS wrapper per IEC 62351-3; otherwise isolate the SCADA link.
  Never bridge DNP3 onto the office LAN unauthenticated.

### OCPP 1.6J / 2.0.1 (EV chargers)

- **Shape:** platform runs an OCPP **Central System** (WebSocket :9000);
  chargers dial in. MeterValues/StatusNotification → telemetry;
  RemoteStart/Stop, SetChargingProfile → control.
- **Plug-in:** new WS server started in `api/boot.ts` (alongside the MQTT
  broker); charger = device row (model `ocpp-charger-*`); decoded samples →
  `persistTelemetry`. Transaction state (start/stop, idTag) maps naturally
  onto the existing commands/audit pattern.
- **Effort:** 4–6 weeks for 1.6J core profile (mature TS/JS libraries
  exist); +2–4 weeks for smart-charging profiles or 2.0.1.
- **Security:** per-charger Basic auth over wss:// (TLS mandatory in
  production); certificate-based mutual TLS for 2.0.1 security profiles;
  rate-limit connection attempts — chargers retry aggressively.

### M-Bus (EN 13757, heat/water/gas meters)

- **Shape:** wired M-Bus needs a level converter/master; **wireless M-Bus**
  (868 MHz) needs an RF gateway that typically forwards decoded telegrams
  over MQTT or TCP — the cleanest integration is a gateway that already
  speaks our MQTT ingest format.
- **Plug-in:** decode VIF/DIF records → canonical keys (energy, volume,
  flow, temperature); one device row per meter (secondary addressing by
  meter ID).
- **Effort:** 2–4 weeks with a gateway doing RF + telegram decode (platform
  side is just a new payload decoder); 6+ weeks for a native wired master.
- **Security:** wireless M-Bus telegram encryption (AES-128 per OMS) must be
  terminated at the gateway or in the decoder — keys are per-meter secrets,
  store them like API keys (hashed/encrypted at rest).

## Related

- `api/protocols/adapter.ts` — interface + registry + Modbus adapter.
- `scripts/seed-sunspec.ts` — SunSpec profile pack (run `--dry-run` to
  validate without DB); documents the 40000/50000 base-block assumption and
  the int+SF decoding caveat that a future adapter should handle natively.
- `docs/architecture.md` — where ingest/poller/control sit in the system.
