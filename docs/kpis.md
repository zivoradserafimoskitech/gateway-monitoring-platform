# Technical KPIs — Gateway Monitoring Platform

Computed on demand from `readings` in 15-minute intervals (`KPI_BUCKET_SEC = 900`).

| KPI | Definition |
| --- | --- |
| Availability | intervals with ≥1 reading / intervals in range |
| Data completeness | Σ min(samples, 900 / pollIntervalSec) / (expected per interval × intervals) |
| Performance ratio (PV) | Σ E_AC / (P_peak × Σ H / 1 kW/m²), only over intervals that have both power and irradiance |

Site KPIs: availability/completeness averaged over devices; PR is weighted by energy.

## Setup
- `meters.peak_power_kwp` — DC peak of the array behind an inverter (`kpis.setPeakPower`).
- `sites.irradiance_meter_id` — device providing `irradianceWm2` (`kpis.setIrradianceMeter`).
Without both, PR is `null`. Migration `0045_technical_kpis.sql`.

## API
- tRPC: `kpis.device`, `kpis.site` (org-scoped, range ≤ 93 days).
- REST: `GET /api/v1/devices/{id}/kpis?from=…&to=…`.
- UI: "Technical KPIs" card on the device page (1/7/30 days).
