# Service Level Agreement — template (D9)

Template for an VoltTrade Cloud managed-monitoring offering. Bracketed
values are defaults to negotiate per contract. This document describes
service levels for the **platform**; field-device and last-mile network
availability are excluded (see §7).

## 1. Service description

Cloud energy monitoring: telemetry ingest (MQTT gateways + Modbus TCP
poller), storage with rollups, dashboards/reports, alarm rules with
notification/escalation, device control (setpoints/curtailment), REST v1
API, Prometheus metrics endpoint.

## 2. Availability target

| Tier | Monthly availability | Max monthly downtime |
|---|---|---|
| Standard | [99.5]% | ~3 h 39 m |
| Premium | [99.9]% | ~43 m |

- Measured as: HTTP 200 on the app health surface and successful telemetry
  ingest commits, sampled [1 min] intervals, excluding maintenance windows
  (§6) and exclusions (§7).
- The platform is single-node by default (app + embedded broker). Achieving
  99.9% requires the Premium deployment pattern: managed/HA database
  (e.g. TiDB Cloud), external HA MQTT broker (`MQTT_URL`), and a standby
  app instance behind the reverse proxy.

## 3. Data durability: RPO / RTO

These tie directly to shipped features — do not promise better than the
deployed configuration:

| Layer | Mechanism | Contribution |
|---|---|---|
| Ingest queue | Telemetry WAL (`data/wal/`, replay on boot, at-least-once) | Survives app crash/restart with **zero loss of received rows** |
| Raw telemetry | 90-day retention (`TELEMETRY_RAW_DAYS`, default 90) + hourly rollups retained beyond | History survives raw-data pruning |
| Database | Nightly `scripts/backup-db.ts` (all 15 tables, gzip JSONL + manifest), off-box copy | **RPO = [24 h]** (= backup interval; schedule more often for stricter RPO) |
| Restore | `scripts/restore-db.ts --verify` then restore + WAL replay | **RTO = [4 h]** typical (minutes to provision DB + restore for typical fleets; telemetry volume dominates) |

- Contractual **RPO: [24 h]**, **RTO: [4 h]** for the Standard tier.
  Premium: RPO [1 h] via 1-hourly backup cron, RTO [1 h] with warm standby.
- Verified by `scripts/probe-v7-backup.ts` and `scripts/probe-v7-wal.ts`.

## 4. Support tiers & response times

| Severity | Definition | First response | Workaround/target fix |
|---|---|---|---|
| S1 — platform down / data loss | ingest stopped fleet-wide, DB unreachable, watchdog critical alarms | [1 h] (24×7 Premium / business hours Standard) | workaround [4 h], fix [24 h] |
| S2 — degraded | one ingest path down (broker or poller), alarm notification broken, API down but UI up | [4 business h] | fix [3 business days] |
| S3 — single site/device | one gateway offline, one device mis-decoding, profile correction | [1 business day] | next release / profile update |
| S4 — how-to / change request | commissioning help, new profile request, SLA/report questions | [2 business days] | scheduled |

Channels: [support email / portal]. S1 requires phone/pager escalation for
Premium.

## 5. Performance targets

- Telemetry ingest → visible in UI: ≤ [2 × device report interval] (MQTT)
  or ≤ [2 × pollIntervalSec] (polled devices).
- API p95 response: ≤ [500 ms] for `/api/v1/*` read endpoints at contracted
  fleet size.
- Alarm breach → notification dispatch: ≤ [1 min] (evaluation is per-sample;
  escalation loop ticks [configurable]).

## 6. Maintenance windows

- Scheduled maintenance: [Tue/Thu 02:00–04:00 local], announced ≥ [48 h]
  in advance by email. Emergency security patches may be applied with
  [4 h] notice.
- During a window, ingest continues to buffer in the WAL and replays after
  restart — short windows cause **no data loss**, only delayed visibility.

## 7. Exclusions

- Field equipment: gateways, meters, inverters, RS-485 wiring, SIM/cellular
  or site internet — monitored **by** the service, not warranted by it.
- Customer-modified device profiles/register maps (editable by design).
- Force majeure, customer-caused outages, third-party broker/DB provider
  failures beyond contracted redundancy.
- Gaps caused by gateway-side outages: the platform cannot backfill data a
  gateway never sent (gateways with local buffering resume on reconnect).

## 8. Reporting & review

Monthly SLA report: availability %, S1/S2 incidents with timeline (from
audit log + watchdog alarm history), backup success rate (verify via
`--verify` spot checks), capacity/telemetry volume trend. Quarterly review to
re-baseline tiers against actual `/metrics` history.
