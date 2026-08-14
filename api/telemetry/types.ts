// Telemetry storage abstraction.
//
// Metadata (gateways, meters, sites, rules, alarms) always lives in MySQL.
// High-volume time-series telemetry goes through this interface, so the store
// can be swapped without touching routers or the MQTT ingestion path:
//
//   TELEMETRY_STORE=mysql      → telemetry in the same MySQL DB (small fleets)
//   TELEMETRY_STORE=timescale  → TimescaleDB hypertables (production, 500+ gateways)
export interface TelemetryRow {
  meterId: number;
  ts: Date;
  // Open key space: the 14 meter MetricKeys plus inverter/BESS/weather keys
  // (contracts/devices.ts). Stores persist the full map.
  values: Record<string, number>;
  raw?: unknown;
}

export interface HistoryPoint {
  ts: Date;
  // Bucket average of the device's PRIMARY_POWER_KEY (#20) — for meters and
  // inverters this equals activePowerKw; for BESS it's batteryPowerKw from
  // values_json. Null when no samples carry the key.
  powerKw: number | null;
  activePowerKw: number | null;
  voltageL1: number | null;
  currentL1: number | null;
  powerFactor: number | null;
  frequencyHz: number | null;
  energyImportKwh: number | null;
  samples: number;
}

export interface TrendPoint {
  bucketSec: number;
  meterId: number;
  avgKw: number | null;
}

export interface DailyReportOpts {
  dayBuckets?: { label: string; startUtc: Date; endUtc: Date }[];
}

export interface DailyReportRow {
  /** UTC calendar day (YYYY-MM-DD) — single, explicit day definition (#8). */
  day: string;
  importKwh: number | null;
  exportKwh: number | null;
  maxDemandKw: number | null;
  /** True when maxDemandKw fell back to active power (no demand register
   *  samples that day) — the UI must label derived values (#21). */
  demandDerived: boolean;
  // v7/C7: a counter decrease (reset/meter swap) was detected inside the day;
  // energy totals are sums of non-negative deltas, flag tells the UI to mark it.
  counterReset: boolean;
  avgPowerFactor: number | null;
  samples: number;
}

// v8/D2: one energy interval bucket for the settlement REST endpoint
// (GET /api/v1/devices/:id/energy). Only NON-EMPTY buckets are returned — the
// REST layer materializes the full consecutive grid and fills gaps with nulls.
export interface EnergyIntervalBucket {
  /** Bucket start, epoch seconds (UTC-aligned multiple of bucketMin×60). */
  bucketStartSec: number;
  importKwh: number | null;
  exportKwh: number | null;
  avgPowerKw: number | null;
  samples: number;
  /** estimated = counter reset detected in the bucket, or the bucket was
   *  expanded from hourly aggregates at sub-hour resolution. */
  estimated: boolean;
}

// audit wave 4 (Task 4): one bucket of a multi-metric series for
// GET /api/v1/devices/:id/telemetry. Only NON-EMPTY buckets are returned —
// the REST layer materializes the full consecutive UTC-aligned grid and fills
// gaps with null values + samples:0 (same contract as EnergyIntervalBucket).
export interface MetricSeriesBucket {
  /** Bucket start, epoch seconds (UTC-aligned multiple of bucketSec). */
  bucketStartSec: number;
  /** AVG per requested key within the bucket; null when no sample carries the key. */
  values: Record<string, number | null>;
  /** Telemetry rows in the bucket (never 0 — empty buckets are omitted). */
  samples: number;
}

// Metric keys become SQL identifiers/expressions, so they CANNOT be sent as
// bind parameters — this whitelist IS the injection defence. The REST layer
// validates first; both stores re-validate (defence in depth).
export const METRIC_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

// Keys backed by a real indexed telemetry column (see writeBatch/HistoryPoint);
// every other key is averaged out of values_json.
export const COLUMN_BACKED_METRICS: Readonly<Record<string, string>> = {
  voltageL1: "voltage_l1",
  voltageL2: "voltage_l2",
  voltageL3: "voltage_l3",
  currentL1: "current_l1",
  currentL2: "current_l2",
  currentL3: "current_l3",
  activePowerKw: "active_power_kw",
  reactivePowerKvar: "reactive_power_kvar",
  apparentPowerKva: "apparent_power_kva",
  powerFactor: "power_factor",
  frequencyHz: "frequency_hz",
  energyImportKwh: "energy_import_kwh",
  energyExportKwh: "energy_export_kwh",
  demandKw: "demand_kw",
};

/** Throw unless every key passes METRIC_KEY_RE (pre-interpolation guard). */
export function assertValidMetricKeys(keys: string[]): void {
  for (const k of keys) {
    if (!METRIC_KEY_RE.test(k)) {
      throw new Error(`invalid metric key ${JSON.stringify(k)} — keys must match ${METRIC_KEY_RE}`);
    }
  }
}

export interface TelemetryStore {
  writeBatch(rows: TelemetryRow[]): Promise<void>;
  latest(meterId: number): Promise<TelemetryRow | null>;
  /** Latest row for EVERY meter in one set-based query (fleet dashboards). */
  latestAll(): Promise<Map<number, TelemetryRow>>;
  history(
    meterId: number,
    from: Date,
    to: Date,
    bucketSec: number,
    powerKey?: string,
  ): Promise<HistoryPoint[]>;
  /** Per-meter average power per bucket — routers aggregate across meters. */
  powerTrend(from: Date, bucketSec: number): Promise<TrendPoint[]>;
  /** Energy counter value of the first sample at/after `from` (for "energy today"). */
  firstEnergySince(meterId: number, from: Date): Promise<number | null>;
  /** Same, for all meters at once, one set-based query. */
  firstEnergyAll(since: Date): Promise<Map<number, number>>;
  // v7/C8: optional local-day buckets (site timezone). When provided, rows are
  // grouped by these UTC ranges instead of UTC-midnight buckets, and `day`
  // carries the local-day label.
  dailyReport(meterId: number, from: Date, to: Date, opts?: DailyReportOpts): Promise<DailyReportRow[]>;
  // v8/D2: settlement energy intervals — non-negative counter deltas + mean
  // power per UTC-aligned bucket; split raw/hourly at the retention cutoff.
  energyIntervals(meterId: number, from: Date, to: Date, bucketMin: number): Promise<EnergyIntervalBucket[]>;
  // audit wave 4 (Task 4): multi-metric AVG series per UTC-aligned bucket for
  // the telemetry REST endpoint. Column-backed keys (COLUMN_BACKED_METRICS)
  // use the real indexed column; all other keys are read from values_json.
  // keys MUST pass METRIC_KEY_RE — implementations re-validate before any
  // interpolation (the whitelist is the injection defence; keys are
  // identifiers, not bind values). Returns only non-empty buckets.
  metricSeries(
    meterId: number,
    from: Date,
    to: Date,
    bucketSec: number,
    keys: string[],
  ): Promise<MetricSeriesBucket[]>;
  close(): Promise<void>;
}
