# Commissioning: site onboarding end-to-end (D9)

From a fresh deployment to live telemetry, alarms and users. UI page names
match the app sidebar; script/env names match this repo.

## 0. Prerequisites

- App running (`:3000`), embedded MQTT broker up (`:1883`, mqtts `:8883` if
  certs exist — see `docs/tls.md`).
- First admin: `npx tsx scripts/seed-admin.ts` (default password printed
  once — **change it after first login** via Settings → change password).
- Device profiles seeded: `npx tsx scripts/seed-profiles.ts` (meters, 20+
  inverter brands, BESS). For SunSpec devices also
  `npx tsx scripts/seed-sunspec.ts`.
- Set hardening env for production: `API_TOKEN` + `VITE_API_TOKEN`,
  `MQTT_USERNAME`/`MQTT_PASSWORD` (broker auth), and decide on
  `MQTT_AUTO_PROVISION` (see step 2).

## 1. Create the site

Gateways page → **Sites** → New site: name + timezone. Day bucketing is UTC
server-side; the timezone is used for display (see README "day/timezone
policy").

## 2. Register the gateway

Three ingestion paths — pick per device reachability:

| Path | When | What to do |
|---|---|---|
| **G30** (MQTT JSON) | gateway publishes parsed JSON | Gateways page → New gateway: **uid** (must match the gateway's published uid), name, model `G30`, assign site. Configure the gateway to mqtts://your-host:8883 with the pinned CA (`docs/tls.md`). |
| **C30** (transparent Modbus RTU) | RS-485 meters/inverters behind the gateway | Same, model `C30`, transport `transparent`. Raw RTU frames ride `d2g/{uid}` up / `g2d/{uid}` down. |
| **Direct TCP** (no gateway) | inverter/BESS with LAN dongle, port 502 reachable | Skip gateway creation — the Modbus TCP poller talks to the device directly. |

**Zero-touch onboarding:** with default env, an unknown gateway that
publishes to the broker is auto-provisioned (model inferred from the topic).
For controlled rollouts set `MQTT_AUTO_PROVISION=0` and create gateways
manually as above.

The gateway row flips online once its first message arrives (liveness is
tracked from traffic; the Gateways page shows status).

## 3. Register meters / devices with model profiles

Devices page → New device:

1. **Model profile** — pick from the dropdown (device_profiles library:
   SEM2250/SEM3250/PEM3000 meters, huawei-sun2000, sungrow-sg-sh,
   sma-sunspec, fronius-sunspec, esmu-bams-stack/string, sunspec-* …). The
   profile supplies the register map, protocol (rtu/tcp), fault-code table
   and any controllable whitelist. Wrong model = garbage values; verify the
   map against the vendor doc (profile `source` field tells you the
   provenance: vendor / community / template).
2. **Attachment** — either a gateway + Modbus **unit id / bus address**
   (C30: RS-485 slave address; ESMU strings: unit id = string no. + 1 per
   the profile notes), or **host/port** for direct TCP (poller). Set
   `pollIntervalSec` for TCP devices (keep < 30 s for ESMU — it drops idle
   sockets at 30 s).
3. Save. TCP devices are picked up by the poller supervisor within 30 s.

### Test connection (direct TCP)

Devices page → device form → **Test connection**
(`meters.testConnection` → `api/poller/test-connection.ts`): opens a TCP
connection and reads a probe register with the selected profile's map. Use
it before leaving the site — it catches wrong host/port, unit id and
base-address assumptions (e.g. SunSpec 40000 vs 50000 block; see the
profile notes).

## 4. Verify telemetry

- **Dashboard** — live power per site/gateway; values should appear within
  one poll/report interval (gateways: the device's own reporting cadence).
- **Device detail page** — latest values map with the profile's keys/units,
  plus history charts. Sanity-check magnitudes (kW vs W, kWh counters).
- **Reports page** — daily energy report once a full hour has rolled up.
- Cross-check with a simulator before field rollout:
  `npx tsx scripts/device-simulator.ts` / `scripts/simulator.ts`,
  or the e2e harnesses `scripts/test-esmu-e2e.ts`, `scripts/test-pv-e2e.ts`.
- No data? Check `/metrics` (`enertrek_telemetry_rows_*`), the platform
  watchdog alarms (Alarms page), and the gateway's MQTT auth/TLS handshake.

## 5. Alarm rules

Alarms page → **Rules**: metric (any decoded key; the dropdown lists
canonical meter/inverter/BESS/weather keys plus `gatewayOffline`),
threshold, severity, optional per-site/device scope. Rules evaluate on
every ingested sample. Wire **notification channels** (email/webhook) in
Settings so breaches push out; escalations run automatically (see
`api/alarms/notify.ts`). The platform itself raises
`platformWatchdogMqtt` / `platformWatchdogPoller` alarms when ingestion is
unhealthy — treat those as page-worthy.

## 6. Users & roles

Settings → Users (admin only). Roles:

| Role | Can |
|---|---|
| `admin` | everything: users, API keys, profiles, control, alarm rules |
| `operator` | operate sites: acknowledge alarms, **execute control setpoints**, register devices |
| `viewer` | read-only dashboards/reports/alarms |

Create one admin, then named operator/viewer accounts — shared logins
defeat the per-user audit trail (every control attempt is logged with
userId in `commands`). For external integrations create **API keys**
(Settings → API keys, shown once) and use the REST v1 API
(`docs/api-v1.md`).

## 7. Control readiness (optional)

Only models whose profile declares a `controllable` whitelist accept
setpoints (e.g. `activePowerLimitPct` for SunSpec model 123 curtailment).
Direct TCP writes are verified by read-back; C30 downlink is asynchronous
("sent", no read-back); G30 has no downlink. Test curtailment once on a
non-critical inverter before relying on it.

## 8. Handover checklist

- [ ] Gateway(s) online, devices decoding sane values for 24 h
- [ ] Hourly rollup + daily report match meter display readings
- [ ] Alarm rules + one notification channel tested end-to-end (force a breach)
- [ ] Named users created; default admin password changed
- [ ] Nightly backup cron installed (`docs/runbook-backup-dr.md`)
- [ ] TLS on both surfaces (`docs/tls.md`); `/metrics` behind proxy auth
- [ ] Operator runbook handed over (`docs/runbook-operators.md`)
