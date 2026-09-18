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
| GET | `/api/v1/openapi.json` | **§9.13: the OpenAPI 3.1 document** for everything in this table — see below. |
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

## Rate limits (§9.13)

Per **key** and per **scope**, not per key alone: a telemetry range scan, a
device listing and an EMS plan push do not cost the same, and one shared
allowance would have to be priced at the dearest of them — throttling the cheap
calls for no reason.

| Scope charged | Default | Env override |
|---|---|---|
| `read` (every GET, and the fallback for anything unrecognised) | 120/min | `RATE_READ_PER_MIN` |
| `telemetry:read` (`GET /devices/:id/telemetry`) | 60/min | `RATE_TELEMETRY_PER_MIN` |
| `control` (every non-GET) | 30/min | `RATE_CONTROL_PER_MIN` |
| `ems:write` (`PUT /devices/:id/ems-plan`) | 30/min | `RATE_EMS_WRITE_PER_MIN` |

A route is charged against the **most specific** scope it requires, so a
telemetry call is billed to `telemetry:read` and not also to `read`.

Every response carries:

```
X-RateLimit-Limit:     120      # requests per minute for the charged scope
X-RateLimit-Remaining: 117      # whole tokens left
X-RateLimit-Scope:     read     # which budget this request was billed to
```

Over the limit is `429` with `Retry-After` in seconds and
`{ "error": …, "retryAfter": N }`.

It is a **token bucket**, not a fixed window: a fixed window lets a caller
spend a full quota at 11:59:59 and another at 12:00:00 — twice the published
rate, at the worst possible moment. Refill is continuous, and burst equals the
per-minute rate, so a client that has been quiet may spend a minute's worth at
once (which is what a batch job looks like) and no more.

Two deliberate behaviours worth knowing:

- Buckets live in the database, so the published number is the number across
  every replica, and it survives a deploy.
- The limiter **fails open**. If its own bookkeeping is unavailable, requests
  are allowed. It exists to bound abuse, not to become a second thing that can
  take the API down.

Unauthenticated and scope-rejected requests are never charged, so nobody can
drain a key's quota by guessing at its id.

## OpenAPI (§9.13)

`GET /api/v1/openapi.json` returns an OpenAPI 3.1 document for everything
above. It sits behind the same Bearer key as every other route: an integrator
has a key by the time they need the spec, and an open endpoint enumerating the
surface is a gift to anyone probing.

The document is hand-written (`api/rest/openapi.ts`) — nothing in this stack
generates one, since the REST surface is Hono handlers rather than a
schema-first framework. What keeps it honest is
`api/rest/openapi-routes.test.ts`, which walks the routes Hono has actually
registered and fails in **both** directions: a route with no spec entry, and a
spec entry for a route that no longer exists. The second is the one that bites,
because a client generated from it discovers the 404 in production.

## Responses & errors

- `200` — JSON body with a single top-level collection key (`sites` / `devices` / `alarms`), `{ deviceId, ts, values, … }`, or the energy-intervals envelope.
- `400` — bad parameter (e.g. invalid `status` value or non-numeric device id).
- `401` — missing/garbage/revoked key, or key past its `expiresAt` (`API key expired`). Revocation takes effect immediately (30 s lookup cache is evicted on revoke).
- `429` — rate limit exceeded for the scope this route charges against; see **Rate limits** above. `Retry-After` says when to come back.
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

## Outbound webhooks (§9.15)

Push instead of poll, and a different thing from a webhook *notification
channel*: a channel is a way to tell a person, a subscription is a way to tell
a system. Three differences follow from that.

**Signed.** Every delivery carries:

```
X-VoltTrade-Signature: t=<unix seconds>,v1=<hex hmac-sha256>
X-VoltTrade-Delivery:  <delivery id>
X-VoltTrade-Event:     <event name>
```

`v1` is HMAC-SHA256 over the exact string `` `${t}.${rawBody}` `` keyed with the
subscription's signing secret. The timestamp is **inside** the MAC on purpose:
signing the body alone would leave a captured request valid forever, because it
could be replayed unchanged. Verify like this:

1. Read the **raw body bytes**. Do not `JSON.parse` and re-serialize — key
   order does not survive the round trip, and the signature is over the bytes.
2. Recompute the MAC and compare in **constant time**.
3. Only then check the clock, and reject anything more than **300 seconds**
   away from now in either direction. Checking the clock first tells an
   attacker which timestamps you accept without them ever holding the secret.

**Queued.** A delivery row is written before anything is sent, so a process
that dies mid-send resumes instead of losing the event. Failures are retried
with exponential backoff and ±25% jitter — 10s, 20s, 40s … capped at an hour,
8 attempts, a little over four hours in total — after which the delivery is
marked `dead` and can be re-queued by hand once the receiver is fixed.

`2xx` is success. `5xx`, a timeout, a connection error, `408` and `429` are
retried. Every other `4xx` is treated as permanent: the receiver is saying the
request is wrong, and sending the identical bytes seven more times will not
make it right.

Delivery is **at-least-once**. A response lost after you committed looks
exactly like a failure from our side, so deduplicate on `X-VoltTrade-Delivery`,
which is stable across retries of the same event.

**Body.**

```jsonc
{
  "id": 1234,                       // delivery id, == X-VoltTrade-Delivery
  "event": "alarm.raised",
  "at": "2026-03-10T09:00:00.000Z", // when the event happened, not when sent
  "data": { /* per-event fields */ }
}
```

The body is frozen when the event happens, not rebuilt at send time: an alarm
that has since resolved is never re-delivered as `raised` carrying a resolved
body.

**Events.**

| Event | When |
|---|---|
| `alarm.raised` | An alarm fired and is live (every rule kind, including gateway-offline and frozen-register) |
| `alarm.suppressed` | An alarm fired but nobody was paged, because a §9.8 suppression was in force. Published deliberately — a human deciding not to be woken is not the condition failing to occur |
| `alarm.resolved` | The condition cleared on its own |
| `command.executed` | A setpoint was written to plant, with its outcome — including writes *rejected* by the whitelist, the verification gate, the range clamp or an emergency stop |

**Management (admin, via tRPC).**

| Procedure | Type | Notes |
|---|---|---|
| `webhooks.create` | mutation | `{ name, url, events[] }` → returns `{ id, secret }`; the secret is shown **once** |
| `webhooks.list` | query | Everything except the secret, plus `consecutiveFailures`, `lastSuccessAt`, `lastError` |
| `webhooks.update` | mutation | `{ id, url?, events?, enabled? }` |
| `webhooks.rotateSecret` | mutation | `{ id }` → `{ secret }`, keeping the subscription's delivery history |
| `webhooks.deliveries` | query | `{ subscriptionId?, status?, limit }` |
| `webhooks.redeliver` | mutation | `{ ids[] }` — re-queue dead deliveries |

A subscription is **never disabled automatically**, however long it has been
failing. An integration that switches itself off is how a customer discovers,
weeks later, that their system stopped receiving alarms; the failure count is
surfaced instead and a human decides.

The endpoint URL goes through the same SSRF checks as every other outbound
target, re-checked at send time rather than only when the subscription was
saved — a hostname that resolved publicly then can be re-pointed at an internal
address afterwards, and these requests carry a signature that makes them look
authentic to whatever receives them.

## Notes

- Alarm **webhooks**: prefer the signed, retried subscriptions above (§9.15).
  The older notification channels (v7/C2) still exist and still POST alarm JSON
  on breach and escalation, unsigned and without retry — they are the right
  tool for a chat hook, not for an integration.
- Rate limiting is built in as of §9.13 (per key, per scope — see above). A
  reverse proxy in front is still worth having for TLS and for bounding
  unauthenticated traffic, which never reaches a bucket by design.
- Verified by `scripts/probe-v7-rest-api.py` (10/10) and `scripts/probe-v8-rest-energy.ts` (energy intervals, 10/10).
