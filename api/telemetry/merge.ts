// Merging of report rows that come from two sources: raw telemetry for the
// recent range and hourly aggregates for the range past the retention cutoff.
//
// Both stores split their range at the cutoff, so both need identical merge
// semantics — a day (or an interval bucket) that straddles the cutoff is
// assembled from one part of each. Extracted here so the two stores cannot
// drift apart, and so the arithmetic is unit-testable without a database.
//
// Rules: energies sum, samples sum, demand takes the max, power factor and
// average power are SAMPLE-WEIGHTED means (a plain average of two averages
// would weight a 1-sample part like a 3600-sample one), and the
// counterReset / estimated flags are sticky. demandDerived is the opposite:
// it only survives if BOTH parts derived their demand from active power.
import type { DailyReportRow, EnergyIntervalBucket, HistoryPoint } from "./types";

const round = (v: number, dp: number) => {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};

/** Sample-weighted mean of two optional averages; null only when both are null. */
function weighted(
  a: number | null,
  an: number,
  b: number | null,
  bn: number,
  dp: number,
): number | null {
  if (a === null) return b;
  if (b === null) return a;
  const tot = an + bn;
  if (tot === 0) return round((a + b) / 2, dp);
  return round((a * an + b * bn) / tot, dp);
}

function sumN(a: number | null, b: number | null, dp: number): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return round(a + b, dp);
}

/** Merge per-day report rows from several range parts, keyed by `day`. */
export function mergeDayRows(parts: DailyReportRow[][]): DailyReportRow[] {
  const map = new Map<string, DailyReportRow>();
  for (const rows of parts) {
    for (const r of rows) {
      const ex = map.get(r.day);
      if (!ex) {
        map.set(r.day, { ...r });
        continue;
      }
      ex.avgPowerFactor = weighted(ex.avgPowerFactor, ex.samples, r.avgPowerFactor, r.samples, 3);
      ex.importKwh = sumN(ex.importKwh, r.importKwh, 2);
      ex.exportKwh = sumN(ex.exportKwh, r.exportKwh, 2);
      ex.maxDemandKw =
        ex.maxDemandKw === null
          ? r.maxDemandKw
          : r.maxDemandKw === null
            ? ex.maxDemandKw
            : Math.max(ex.maxDemandKw, r.maxDemandKw);
      ex.demandDerived = ex.demandDerived && r.demandDerived;
      ex.counterReset = ex.counterReset || r.counterReset;
      ex.samples += r.samples;
    }
  }
  return [...map.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}

/** Merge settlement interval buckets from several range parts, keyed by bucket start. */
export function mergeEnergyBuckets(parts: EnergyIntervalBucket[][]): EnergyIntervalBucket[] {
  const map = new Map<number, EnergyIntervalBucket>();
  for (const b of parts.flat()) {
    const ex = map.get(b.bucketStartSec);
    if (!ex) {
      map.set(b.bucketStartSec, { ...b });
      continue;
    }
    ex.avgPowerKw = weighted(ex.avgPowerKw, ex.samples, b.avgPowerKw, b.samples, 3);
    ex.importKwh = sumN(ex.importKwh, b.importKwh, 3);
    ex.exportKwh = sumN(ex.exportKwh, b.exportKwh, 3);
    ex.samples += b.samples;
    ex.estimated = ex.estimated || b.estimated;
  }
  return [...map.values()].sort((a, b) => a.bucketStartSec - b.bucketStartSec);
}

/**
 * Merge chart points from the raw and the aggregated part of a range.
 *
 * Same shape of problem as the report merge, one bucket at a time: a bucket
 * that straddles the retention cutoff is half raw samples and half rollup
 * rows. Averages are sample-weighted; the energy counter takes the later
 * (larger) reading, matching `max(energy_import_kwh)` in both raw queries.
 */
export function mergeHistoryPoints(parts: HistoryPoint[][]): HistoryPoint[] {
  const map = new Map<number, HistoryPoint>();
  const keys = [
    "powerKw",
    "activePowerKw",
    "voltageL1",
    "currentL1",
    "powerFactor",
    "frequencyHz",
  ] as const;
  for (const p of parts.flat()) {
    const at = p.ts.getTime();
    const ex = map.get(at);
    if (!ex) {
      map.set(at, { ...p });
      continue;
    }
    for (const k of keys) ex[k] = weighted(ex[k], ex.samples, p[k], p.samples, 4);
    ex.energyImportKwh =
      ex.energyImportKwh === null
        ? p.energyImportKwh
        : p.energyImportKwh === null
          ? ex.energyImportKwh
          : Math.max(ex.energyImportKwh, p.energyImportKwh);
    ex.samples += p.samples;
  }
  return [...map.values()].sort((a, b) => a.ts.getTime() - b.ts.getTime());
}
