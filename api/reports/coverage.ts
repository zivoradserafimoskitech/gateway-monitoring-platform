// §9.7 data quality: how complete is the data behind a reported number?
//
// A daily report already carries a sample count, but a count alone says
// nothing — 96 is excellent for a 15-minute meter and catastrophic for one
// that reports every 30 seconds. Without that context a day the gateway spent
// mostly offline looks exactly like a normal day with a smaller total, and the
// number gets invoiced.
//
// The expected rate is derived from the report itself rather than configured:
// the median sample count of the other days IS the device's normal rate. That
// calibrates per device with no nominal interval to maintain, works the same
// for an MQTT device that pushes and a Modbus device that is polled, and needs
// no schema change or store-specific query — the rows are already in hand.
import type { DailyReportRow } from "../telemetry/types";

/** A day is complete enough not to be worth flagging above this. */
export const COVERAGE_OK = 0.9;

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export interface DailyReportRowWithCoverage extends DailyReportRow {
  /**
   * Samples on this day over the fleet-normal count for this device, capped at
   * 1. Null when the report is too short to calibrate — one or two days give
   * no honest baseline, and a fabricated one is worse than saying nothing.
   */
  coverage: number | null;
}

export function withCoverage(days: DailyReportRow[]): DailyReportRowWithCoverage[] {
  // Days with no samples at all are excluded from the baseline: a run of empty
  // days would drag the median to zero and make the remaining days look
  // complete, which is exactly backwards.
  const populated = days.filter((d) => d.samples > 0).map((d) => d.samples);
  // Three populated days is the minimum that makes a median mean anything —
  // with two, one bad day IS the median.
  const baseline = populated.length >= 3 ? median(populated) : null;
  return days.map((d) => ({
    ...d,
    coverage:
      baseline === null || baseline <= 0 ? null : Math.min(1, Math.round((d.samples / baseline) * 100) / 100),
  }));
}
