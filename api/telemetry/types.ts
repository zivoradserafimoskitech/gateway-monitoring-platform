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
  close(): Promise<void>;
}
