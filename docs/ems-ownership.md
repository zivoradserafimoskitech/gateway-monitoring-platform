# EMS ownership: Gateway Monitoring Platform vs VoltTrade

| Concern | Owner | Notes |
|---|---|---|
| Device data ingestion, protocols, liveness | **Gateway Monitoring Platform** | Source of truth for device state |
| Alarms (raise, clear, notify) | **Gateway Monitoring Platform** | VoltTrade mirrors via webhooks, never re-evaluates |
| Command execution, read-back, audit | **Gateway Monitoring Platform** | `POST /api/v1/devices/:id/commands` |
| Hard limits: grid connection limit, safety curtailment, SoC guard, emergency stop | **Gateway Monitoring Platform** | Always applied on top of any plan |
| Prices, forecast, optimisation, trading | **VoltTrade** | Pushed as plans |
| Commercial tariffs, battery economics (cycle cost, efficiency for €) | **VoltTrade** | Gateway copy deprecated |
| Economic PV curtailment (negative prices, contracts) | **VoltTrade** | Arrives as a plan |
| Billing, customers | **VoltTrade** | |

## Plan precedence

Controller priority per device per tick (unchanged safety order):

1. Grid connection limit (hard, `api/ems/curtail.ts`)
2. Peak shaving clamp
3. **Plan** — chosen by `api/ems/plan-source.ts`:
   - a **fresh external plan** (any `source` other than `tariff-optimizer`,
     pushed with `PUT /api/v1/devices/:id/ems-plan`) always wins, regardless
     of which plan was written last;
   - otherwise the newest **local fallback** plan (`tariff-optimizer`);
   - a stale external plan is used only when no local plan exists.
4. Schedules

The local TOU optimiser (`api/ems/optimizer.ts`) **does not write a plan** while
a fresh external plan covers the device.

| Env | Default | Meaning |
|---|---|---|
| `EMS_EXTERNAL_PLAN_MAX_AGE_MIN` | `1440` | An external plan older than this (since push) is stale and the fallback may take over. `0` = never stale |
| `EMS_LOCAL_OPTIMIZER` | `fallback` | `off` disables local planning entirely |

`GET /api/v1/devices/:id/plan-execution` shows which plan is in force.

## PV curtailment split

- **Gateway (safety):** the grid connection import/export limit and its
  stepwise curtailment (`api/ems/curtail.ts`, `GridLimitCard`) are hard limits.
  They run first every tick and override any plan.
- **VoltTrade (economics):** curtailing because the price is negative or a
  contract says so is an economic decision. VoltTrade sends it as a plan
  (or as a `p_limit_pct` command via `/commands`). The gateway never decides to
  curtail for money.

## Deprecated commercial tables (non-destructive)

`tariffs`, `tariff_periods`, `tariff_prices` and `battery_economics` remain
because the fallback optimiser reads them as a **simple TOU profile**.
Migration `0042_deprecate_commercial_tables.sql` only adds table comments.
The UI shows the editor collapsed under "Fallback TOU profile".

Removal plan (owner decision, not done):

1. Keep the tables while any site relies on the fallback.
2. Once VoltTrade pushes plans for every battery, set `EMS_LOCAL_OPTIMIZER=off`
   for one release and watch `plan-execution`.
3. Export the tables (`scripts/backup-db.ts`), then drop them in a new
   migration together with `api/ems/optimizer.ts`, `tariff.ts` and `TariffCard`.

## Webhooks to VoltTrade

`alarm.raised`, `alarm.cleared`, `device.online`, `device.offline`,
`plan.accepted`, `plan.rejected`, `plan.executed`, `command.confirmed`,
`energy.interval.closed` — signed and retried as described in docs/api-v1.md.
Suggested API keys for VoltTrade: one `read` + `telemetry:read`, one
`control` + `ems:write` for plans, one `control` + `control:write` for commands.
