# High availability (v8/D6)

Two stateless-ish app replicas behind nginx, a 2-node EMQX cluster for the
gateway fleet, TiDB (or managed MySQL) for metadata, TimescaleDB for
telemetry. The app connects to the broker as a **client** via `MQTT_URL`;
when unset it uses the local dev broker (`scripts/broker.ts`) — there is no
embedded broker inside the app process.

## Architecture

```mermaid
flowchart LR
    subgraph Fleet
        G[G30/C30 gateways<br/>MQTT uplink]
    end
    subgraph Brokers[EMQX static cluster]
        E1[emqx1<br/>dashboard :18083 localhost]
        E2[emqx2]
        E1 <-->|cluster cookie + static seeds| E2
    end
    subgraph Apps[App replicas]
        A1[app-1 :3000<br/>healthz / readyz / metrics]
        A2[app-2 :3000<br/>healthz / readyz / metrics]
    end
    N[nginx :80<br/>least_conn upstream]
    subgraph Data
        T[(TiDB / MySQL<br/>DATABASE_URL)]
        TS[(TimescaleDB<br/>telemetry)]
        W1[(wal-1 local<br/>per-replica WAL)]
        W2[(wal-2 local<br/>per-replica WAL)]
    end
    G -->|mqtt :1883| E1
    G -->|mqtt :1883| E2
    E1 & E2 -->|shared subscription<br/>$share/enertrek/#| A1 & A2
    N --> A1
    N --> A2
    A1 & A2 --> T
    A1 & A2 --> TS
    A1 --- W1
    A2 --- W2
```

## Health endpoints

| Endpoint   | Purpose   | Result |
|------------|-----------|--------|
| `/healthz` | liveness  | 200 always — process is up |
| `/readyz`  | readiness | 200 when DB ping (`SELECT 1`) **and** broker connected; otherwise **503** with `{ reason, components: { db, broker, brokerMode } }` |

Both are unauthenticated and live next to `/metrics`, outside `/api/trpc`
auth. The compose healthcheck gates nginx `depends_on: service_healthy` on
`/readyz`; nginx itself evicts failing replicas via `max_fails`.

## Zero-downtime rolling deploy

One replica at a time — nginx keeps serving through the other:

```bash
docker compose -f docker-compose.prod.yml up -d --no-deps --build app-1
# wait for healthy:  docker compose -f docker-compose.prod.yml ps
docker compose -f docker-compose.prod.yml up -d --no-deps --build app-2
```

Blue-green alternative: keep the old image tag running as a third temporary
upstream, switch `deploy/nginx.conf`, reload nginx (`nginx -s reload`), then
drain. Schema migrations are **additive-only** (see `db/migrations`), so old
and new code can coexist against the same DB during the roll.

## State audit — what lives where

| State | Location | Replica-safe? |
|---|---|---|
| Sessions (cookies) | `sessions` table in **DB** | yes — any replica serves any session |
| Session/user cache | DB + 60 s **RAM** cache per replica | yes — writes call `evictUserCache()`; worst case 60 s staleness on the other replica |
| API keys | DB + RAM cache | yes — `evictApiKeyCache()` on revoke/create |
| Telemetry WAL | **local disk per replica** (`TELEMETRY_WAL_DIR`) | per-replica by design — **never share the volume** (append/offset log; two writers corrupt offsets and double-replay). Replicas write disjoint batches because ingestion is shared-subscription balanced |
| Telemetry data | TimescaleDB | yes |
| OTA job state | `ota_jobs` in DB | yes (see below) |
| EMS schedules/config | DB | yes (see below) |
| Report schedules | DB | yes (see below) |
| Report artifacts | `data/reports/` local disk per replica | files are per-run artifacts; email is the delivery path |
| MQTT broker state | EMQX cluster | 2-node static cluster, shared cookie |

## Duplicate-loop analysis (2 replicas)

All background loops run on **every** replica. Effects and guards:

| Loop | Duplicate effect | Guard |
|---|---|---|
| **MQTT ingestion** | Two clients subscribing `#` would both receive every uplink → double telemetry rows | **Shared subscription**: when `MQTT_URL` is set the app subscribes `$share/enertrek/#` — EMQX delivers each message to exactly one group member. (Embedded dev broker aedes lacks `$share`, so dev keeps plain `#`; set `MQTT_SHARED_SUB=0` for external brokers without `$share` support — then replicas each get every message, i.e. run a single replica.) |
| **EMS controller** | Both replicas evaluate the same schedules and could write the same setpoint twice | FC6 writes are **value-idempotent**: writing the same setpoint twice is semantically a no-op for the device. The 5-min in-RAM dedup is per replica, so the first tick after boot may produce a duplicate audit row in `commands` — cosmetic only. Peak-shaving same. |
| **OTA manager** | Both replicas dispatch the same pending job → two publishes of the same jobId | The device acks once per delivery; `handleOtaAck` only transitions jobs still in `sent` status — the second ack is ignored. Timeout sweep (`attempts++`) can double-increment in the worst case → job may fail one attempt early; harmless and logged. |
| **Report scheduler** | Both replicas pass `isDue` in the same minute → **duplicate email** | **Implemented guard**: before generating, the loop claims the period with an atomic conditional `UPDATE report_schedules SET last_run_at = <now> WHERE id = ? AND (last_run_at IS NULL OR last_run_at < <period_start>)`. TiDB row-locking lets exactly one replica win; the loser sees 0 affected rows and skips. At-most-once per period: if the winner crashes mid-send, that period's email is lost rather than doubled. |
| **Retention/rollup** | Both replicas run the hourly rollup + raw retention | Rollup upserts hourly aggregates (`INSERT … ON DUPLICATE KEY UPDATE`) and retention deletes by time window — both are naturally idempotent. |
| **Watchdog / alarm escalation** | Duplicate alert checks / notification attempts | Alarm transitions are status-guarded in DB; escalation mail may duplicate in the worst case (same as a retry). |
| **Modbus TCP poller** | Two replicas polling the same direct-TCP device → **double telemetry rows** | Honest limit: run the poller on ONE replica (`POLLER_ENABLED=0` on the other via an override file) when direct-TCP devices exist. MQTT-only fleets are unaffected. |

## Failover drills

Executed 2026-08-13 (audit wave 3) — full evidence in
`docs/DRILL-EVIDENCE.md`:

- **Broker kill drill**: `pkill` on the embedded dev broker → watchdog
  restarted it in 20 s, `/readyz` back to 200 in ≤ 59 s, sims + app MQTT
  client reconnected, **0 telemetry rows lost**, ~60 duplicate rows from
  at-least-once redelivery (documented tolerance).
- **Backup → scratch restore drill**: `scripts/dr/backup-restore-drill.ts`,
  all 7 audit tables restored into `volttrade_dr_drill` and checksum-verified
  (backup 11.4 s, restore 2.8 s), scratch DB dropped afterwards.
- Organic same-day evidence: the watchdog recovered the whole stack after a
  full outage at 10:19Z; a second outage (11:08Z–12:21Z) showed the watchdog
  itself has no supervisor — run it under systemd/cron in real deployments.

Drills repeat quarterly (next: 2026-11-13), rotating the killed component.

## Honest limits

- **Metadata DB**: a single TiDB Serverless endpoint (private link) is a
  single point of failure; the app degrades to 503 on `/readyz` but nginx
  still routes to replicas (they return API errors, static UI keeps loading).
  Multi-AZ TiDB or managed MySQL HA is out of scope.
- **Broker endpoint for gateways**: the fleet points at one DNS name;
  put a TCP LB in front of emqx1/emqx2 (or use EMQX's built-in LB) for true
  broker HA — the compose file exposes 1883 on emqx1 only for clarity.
- **Broker migration**: moving an existing deployment from the embedded dev
  broker to external EMQX is a config change (`MQTT_URL`, repoint gateways)
  — no data migration; retained downlink commands should be re-published
  (`replayRetainedDownlinks` only replays from the broker the app is
  connected to).
- **Poller duplication** (above) and **EMS duplicate-audit** (above) are the
  known cosmetic/edge artifacts of multi-replica operation.
