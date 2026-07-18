// Telemetry storage abstraction.
//
// Metadata (gateways, meters, sites, rules, alarms) always lives in MySQL.
// High-volume time-series telemetry goes through this interface, so the store
// can be swapped without touching routers or the MQTT ingestion path:
//
//   TELEMETRY_STORE=mysql      → telemetry in the same MySQL DB (small fleets)
//   TELEMETRY_STORE=timescale  → TimescaleDB hypertables (production, 500+ gateways)
import type { MetricKey } from "@contracts/modbus";

export interface TelemetryRow {
  meterId: number;
  ts: Date;
  values: Partial<Record<MetricKey, number>>;
  raw?: unknown;
}

export interface HistoryPoint {
  ts: Date;
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

export interface DailyReportRow {
  day: string;
  importKwh: number | null;
  exportKwh: number | null;
  maxDemandKw: number | null;
  avgPowerFactor: number | null;
  samples: number;
}

export interface TelemetryStore {
  writeBatch(rows: TelemetryRow[]): Promise<void>;
  latest(meterId: number): Promise<TelemetryRow | null>;
  /** Latest row for EVERY meter in one set-based query (fleet dashboards). */
  latestAll(): Promise<Map<number, TelemetryRow>>;
  history(meterId: number, from: Date, to: Date, bucketSec: number): Promise<HistoryPoint[]>;
  /** Per-meter average power per bucket — routers aggregate across meters. */
  powerTrend(from: Date, bucketSec: number): Promise<TrendPoint[]>;
  /** Energy counter value of the first sample at/after `from` (for "energy today"). */
  firstEnergySince(meterId: number, from: Date): Promise<number | null>;
  /** Same, for all meters at once, one set-based query. */
  firstEnergyAll(since: Date): Promise<Map<number, number>>;
  dailyReport(meterId: number, from: Date, to: Date): Promise<DailyReportRow[]>;
  close(): Promise<void>;
}
