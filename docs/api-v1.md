# Public REST API v1 (v7/C11)

Read-only JSON API for external integrations (dashboards, SCADA bridges,
billing, fleet tooling). Authentication: **Bearer API key** — keys are created
by admins in the app (tRPC `apiKeys.create`) and shown **exactly once**; only
the sha256 hash + 12-char prefix are stored.

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
| 401 | missing/garbage/revoked Bearer key |
| 404 | unknown device id |

## Responses & errors

- `200` — JSON body with a single top-level collection key (`sites` / `devices` / `alarms`), `{ deviceId, ts, values, … }`, or the energy-intervals envelope.
- `400` — bad parameter (e.g. invalid `status` value or non-numeric device id).
- `401` — missing/garbage/revoked key. Revocation takes effect immediately (30 s lookup cache is evicted on revoke).
- `404` — unknown device id.

## Key management (admin, via tRPC)

| Procedure | Type | Notes |
|---|---|---|
| `apiKeys.create` | mutation | `{ name, role }` → returns `{ key }` **once** |
| `apiKeys.list` | query | id, name, prefix, role, createdAt, lastUsedAt, revokedAt |
| `apiKeys.revoke` | mutation | `{ id }` — instant revoke |

Key roles mirror the RBAC roles (`admin`/`operator`/`viewer`); v1 is read-only
for all roles — write scopes arrive with the control API (C12). `lastUsedAt`
is updated at most once per minute per key.

## Notes

- Alarm **webhooks** (push instead of poll) are available via the notification
  channels (v7/C2): register a webhook channel and alarms POST to it on
  breach + escalation.
- Rate limiting is not built in — front the API with your reverse proxy
  (Caddy/Nginx) if you expose it publicly; keys are per-integration so you can
  revoke a leaking client without touching others.
- Verified by `scripts/probe-v7-rest-api.py` (10/10) and `scripts/probe-v8-rest-energy.ts` (energy intervals, 10/10).
