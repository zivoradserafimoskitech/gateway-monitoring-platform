# Public REST API v1 (v7/C11)

Read-only JSON API for external integrations (dashboards, SCADA bridges,
billing, fleet tooling). Authentication: **Bearer API key** — keys are created
by admins in the app (tRPC `apiKeys.create`) and shown **exactly once**; only
the sha256 hash + 12-char prefix are stored.

Keys may carry an optional **expiry** (`expiresAt`) and **scope restriction**
(`scopes`): an expired key gets `401 { "error": "API key expired" }`; a key
whose scopes don't cover the route gets `403 { "error": "API key lacks
required scope: <scope>" }`.

**Scope model (audit wave 4):**

| Scope | Grants |
|---|---|
| `read` | All GET routes (coarse method mapping: GET → `read`) |
| `control` | All PUT/POST/DELETE routes (coarse method mapping) |
| `telemetry:read` | `GET /api/v1/devices/:id/telemetry` — **in addition to** `read` |
| `ems:write` | `PUT /api/v1/devices/:id/ems-plan` — **in addition to** `control` |

**Keys with `scopes = NULL` (legacy) are READ-ONLY** — they pass only the
`read` check; `control` / `telemetry:read` / `ems:write` routes return 403.
(This was flipped from "full access" in audit wave 4.) **Role does not imply
scope**: an `admin`-role key without `ems:write` cannot push an EMS plan.

> **Deploy note:** the ERP production API key MUST be created with
> `role = operator` **and** `scopes = ["read", "control", "ems:write",
> "telemetry:read"]` — anything less gets 403 on plan pushes and/or
> telemetry pulls.

```bash
curl -H "Authorization: Bearer etk_…" https://your-host/api/v1/devices
```

## Endpoints

| Method | Path | Description |
|---|---|---|
| GET | `/api/v1/sites` | All sites (id, name, timezone, address). |
| GET | `/api/v1/devices` | All devices: `{ devices: [{ id, name, model, deviceType, siteId, gatewayId, status, … }] }` — `deviceType` ∈ `meter\|inverter\|bess`, `status` ∈ `online\|offline` (liveness). Extra backward-compatible fields: gateway context (`gatewayUid`, `gatewayStatus`, …) and `effectiveSiteId` (own site ?? gateway site — the v6 coalesce rule). |
| GET | `/api/v1/devices/:id/latest` | Latest telemetry: `{ deviceId, ts, values }` — the full open-key map (power, energy, BESS/inverter keys per device profile). `ts: null, values: {}` when no data yet. (Legacy `latest: { ts, values }` wrapper still included.) |
| GET | `/api/v1/devices/:id/energy` | **v8/D2 settlement energy intervals** — see below. |
| GET | `/api/v1/devices/:id/telemetry` | **audit wave 4: multi-metric bucketed series** (any telemetry keys, e.g. SoC trend) — see below. Requires `telemetry:read`. |
| PUT | `/api/v1/devices/:id/ems-plan` | **v9 Contract A: push an EMS plan** (upsert/supersede) — see below. |
| GET | `/api/v1/devices/:id/ems-plan` | **v9 Contract A:** the active plan covering now, else the next upcoming active plan, else `{ "plan": null }`. |
| GET | `/api/v1/alarms?status=` | Alarms, newest first (limit 500). `status`: `active` (default) \| `acknowledged` \| `resolved` \| `all`. |

## Energy intervals (ERP / billing)

`GET /api/v1/devices/:id/energy?from=<ISO8601>&to=<ISO8601>&bucketMin=<15..1440>`

Settlement-grade per-bucket energy for one device — designed for ERP pulls
(e.g. Supabase edge functions). Buckets are **UTC-aligned** (epoch multiples of
`bucketMin × 60`), consecutive from `floor(from)` to `ceil(to)`; buckets with
no samples are present with `null` values (never omitted).

| Param | Required | Rule |
|---|---|---|
| `from` | yes | ISO8601; must be `< to`; range ≤ 31 days |
| `to` | yes | ISO8601 |
| `bucketMin` | no (default 60) | integer, 15..1440 |

`importKwh`/`exportKwh` are counter deltas within the bucket using the
counter-reset-safe non-negative-delta logic (a counter decrease clamps the
delta to 0 instead of exploding the total; keys `energyImportKwh` /
`energyExportKwh`, fixed column with `values_json` fallback). `avgPowerKw` is
the mean of `activePowerKw` samples. Ranges older than the raw-retention
cutoff (`TELEMETRY_RAW_DAYS`, default 90 d) are served from hourly aggregates;
sub-hour buckets over that range are expanded evenly and marked `estimated`.

`quality`: `"measured"` normally; `"estimated"` when a counter reset was
detected inside the bucket or the bucket was expanded from hourly aggregates.

Response 200 (worst case 31 d × 15 min = 2976 buckets):

```json
{
  "deviceId": 1,
  "from": "2026-08-09T00:00:00.000Z",
  "to": "2026-08-10T00:00:00.000Z",
  "bucketMin": 60,
  "buckets": [
    { "ts": "2026-08-09T00:00:00.000Z", "importKwh": 14.974, "exportKwh": 0, "avgPowerKw": 15.01, "quality": "measured" },
    { "ts": "2026-08-09T01:00:00.000Z", "importKwh": null, "exportKwh": null, "avgPowerKw": null, "quality": "measured" }
  ]
}
```

| Status | Condition |
|---|---|
| 400 | missing/unparsable `from`/`to`, `from >= to`, range > 31 days, `bucketMin` not an integer in 15..1440, non-numeric device id |
| 401 | missing/garbage/revoked/**expired** Bearer key |
| 403 | key scopes don't include `read` |
| 404 | unknown device id |

## Telemetry series (multi-metric, audit wave 4)

`GET /api/v1/devices/:id/telemetry?from=<ISO8601>&to=<ISO8601>&keys=<a,b,…>&bucketMin=<1..1440>`

Bucketed **AVG series for arbitrary metric keys** of one device — designed
for ERP/InfluxDB-style consumers that need trends (state of charge, battery
power, …) rather than settlement energy. Requires the **`telemetry:read`**
scope in addition to `read`.

| Param | Required | Rule |
|---|---|---|
| `from` | yes | ISO8601; must be `< to`; range ≤ 31 days |
| `to` | yes | ISO8601 |
| `keys` | yes | 1–16 comma-separated metric keys, each matching `/^[A-Za-z][A-Za-z0-9_]{0,63}$/` |
| `bucketMin` | no (default 15) | integer, 1..1440 |

Metric keys are either **column-backed** (`activePowerKw`, `voltageL1..3`,
`currentL1..3`, `reactivePowerKvar`, `apparentPowerKva`, `powerFactor`,
`frequencyHz`, `energyImportKwh`, `energyExportKwh`, `demandKw` — averaged
from the real indexed column) or open keys read from `values_json` (e.g.
`socPercent`, `batteryPowerKw` for BESS). The key whitelist is enforced
before any SQL interpolation — keys are identifiers, not bind values.

Buckets are **UTC-aligned** (epoch multiples of `bucketMin × 60`) and the
response is the **full consecutive grid** from `floor(from)` to `ceil(to)`:
buckets without samples are **present** with every key `null` and
`samples: 0` — a measured `0` ("the battery was idle") and "no data" are
never indistinguishable.

```bash
curl -H "Authorization: Bearer etk_…" \
  "https://your-host/api/v1/devices/42/telemetry?from=2026-08-13T00:00:00Z&to=2026-08-14T00:00:00Z&keys=socPercent,batteryPowerKw&bucketMin=15"
```

Response 200 (worst case 31 d × 1 min = 44 640 buckets):

```json
{
  "deviceId": 42,
  "from": "2026-08-13T00:00:00.000Z",
  "to": "2026-08-14T00:00:00.000Z",
  "bucketMin": 15,
  "keys": ["socPercent", "batteryPowerKw"],
  "buckets": [
    { "ts": "2026-08-13T00:00:00.000Z", "values": { "socPercent": 61.2, "batteryPowerKw": 0 }, "samples": 15 },
    { "ts": "2026-08-13T00:15:00.000Z", "values": { "socPercent": null, "batteryPowerKw": null }, "samples": 0 }
  ]
}
```

| Status | Condition |
|---|---|
| 400 | missing/unparsable `from`/`to`, `from >= to`, range > 31 days, missing/empty `keys`, more than 16 keys, a key failing the whitelist, `bucketMin` not an integer in 1..1440, non-numeric device id |
| 401 | missing/garbage/revoked/**expired** Bearer key |
| 403 | key scopes don't include `read` + `telemetry:read` (NULL-scopes legacy keys are read-only and get 403 here) |
| 404 | unknown device id **or not in the key's org** |

## EMS plans (v9 Contract A — optimizer push)

`PUT /api/v1/devices/:id/ems-plan` pushes a time-boxed **step-function
setpoint series** for one BESS device — designed for the VoltTrade portfolio
optimizer, but any integration with a valid key can use it.

**Sign convention: `kw > 0` = discharge, `kw < 0` = charge, `0` = idle**
(matches the control-register semantics "+ = discharge"). The EMS controller
clamps to the meter's controllable register range (a charge setpoint is only
written as a negative value when the register's range allows it).

```bash
curl -X PUT -H "Authorization: Bearer etk_…" -H "Content-Type: application/json" \
  -d '{
        "validFrom": "2026-08-12T00:00:00Z",
        "validTo":   "2026-08-13T00:00:00Z",
        "source":    "volttrade",
        "setpoints": [
          { "ts": "2026-08-12T00:00:00Z", "kw": -30 },
          { "ts": "2026-08-12T11:00:00Z", "kw": 50 },
          { "ts": "2026-08-12T17:00:00Z", "kw": 0 }
        ]
      }' \
  https://your-host/api/v1/devices/42/ems-plan
# → 200 { "planId": 7, "status": "active", "superseded": 1 }

curl -H "Authorization: Bearer etk_…" https://your-host/api/v1/devices/42/ems-plan
# → 200 { "plan": { "id": 7, "meterId": 42, "orgId": 1, "source": "volttrade",
#                   "validFrom": "…", "validTo": "…", "setpoints": [ … ],
#                   "status": "active", "createdAt": "…" } }
```

| Field | Rule |
|---|---|
| `validFrom` / `validTo` | ISO8601; `validTo > validFrom`; span ≤ 48 h |
| `source` | optional string ≤ 64 chars (default `"unknown"`) — attribution tag, echoed in the command audit trail as `plan:<source>` |
| `setpoints` | 1..192 entries, sorted non-descending by `ts`, every `ts` within `[validFrom, validTo]`, `kw` finite with \|kw\| ≤ 500 |

**Semantics:** upsert — every existing `active` plan of the same device whose
window overlaps `[validFrom, validTo)` is atomically marked `superseded`
(response counts them), then the new plan is inserted `active`.

**Execution:** per controller tick the priority is **peak shaving > active
plan > schedules > idle**. A plan covering now drives the register with the kw
of the last setpoint with `ts ≤ now` (step function); execution goes through
the same interlock + audit path as schedules (system command, `userId` null,
`result` prefixed `plan:<source>`). Plans past `validTo` are lazily marked
`expired`. `EMS_TICK_S<=0` disables plan execution together with everything
else. Fail-safe: if the optimizer stops pushing, the device falls back to
local schedules / idle.

| Status | Condition |
|---|---|
| 400 | unparsable/missing `validFrom`/`validTo`, `validTo <= validFrom`, span > 48 h, bad `source`, setpoints not 1..192 / unsorted / `ts` outside the window / non-finite or \|kw\| > 500, non-numeric device id, non-JSON body |
| 401 | missing/garbage/revoked/**expired** Bearer key |
| 403 | key scopes don't include `control` **and** `ems:write` (role alone is not enough — even an `admin`-role key needs the scopes) |
| 404 | device unknown **or not in the key's org** |

## Responses & errors

- `200` — JSON body with a single top-level collection key (`sites` / `devices` / `alarms`), `{ deviceId, ts, values, … }`, or the energy-intervals envelope.
- `400` — bad parameter (e.g. invalid `status` value or non-numeric device id).
- `401` — missing/garbage/revoked key, or key past its `expiresAt` (`API key expired`). Revocation takes effect immediately (30 s lookup cache is evicted on revoke).
- `403` — the key's scopes don't cover the route's required scope (`read` for GET, `control` for PUT/POST/DELETE, plus `telemetry:read` for the telemetry endpoint and `ems:write` for plan pushes). Since audit wave 4, NULL-scopes legacy keys are **read-only** and therefore get 403 on every non-read route.
- `404` — unknown device id.

## Key management (admin, via tRPC)

| Procedure | Type | Notes |
|---|---|---|
| `apiKeys.create` | mutation | `{ name, role, expiresAt?, scopes? }` → returns `{ key }` **once**; `expiresAt` is an ISO8601 datetime, `scopes` a subset of `["read", "control", "telemetry:read", "ems:write"]` (omit for a legacy key — **read-only** since audit wave 4) |
| `apiKeys.list` | query | id, name, prefix, role, createdAt, lastUsedAt, revokedAt, expiresAt, scopes |
| `apiKeys.revoke` | mutation | `{ id }` — instant revoke |

Key roles mirror the RBAC roles (`admin`/`operator`/`viewer`). `lastUsedAt`
is updated at most once per minute per key.

## Notes

- Alarm **webhooks** (push instead of poll) are available via the notification
  channels (v7/C2): register a webhook channel and alarms POST to it on
  breach + escalation.
- Rate limiting is not built in — front the API with your reverse proxy
  (Caddy/Nginx) if you expose it publicly; keys are per-integration so you can
  revoke a leaking client without touching others.
- Verified by `scripts/probe-v7-rest-api.py` (10/10) and `scripts/probe-v8-rest-energy.ts` (energy intervals, 10/10).
