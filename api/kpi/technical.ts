// Technical KPIs (devices / physics — not money):
//
//   availability       share of 15-min intervals in which the device reported
//                      at least once (communication availability).
//   dataCompleteness   samples received / samples expected from the device's
//                      poll interval, capped per interval at 100%.
//   performanceRatio   PV only (IEC 61724 style, simplified):
//                        PR = E_ac / (H_poa × P_peak)
//                      E_ac   AC energy from mean active power per interval [kWh]
//                      H_poa  plane-of-array irradiation from the site's
//                             irradiance sensor [kWh/m²], 1 kW/m² reference
//                      P_peak DC peak power of the inverter's array [kWp]
//                      Only intervals where BOTH power and irradiance exist
//                      count, so a sensor outage does not inflate PR.
// Commercial KPIs (revenue, savings) belong to VoltTrade.

export const KPI_BUCKET_SEC = 900;

export interface SeriesBucket {
  bucketStartSec: number;
  samples: number;
  values: Record<string, number | null>;
}

export function bucketsBetween(fromMs: number, toMs: number, bucketSec = KPI_BUCKET_SEC): number {
  const b = bucketSec * 1000;
  const start = Math.ceil(fromMs / b) * b;
  const end = Math.floor(toMs / b) * b;
  return Math.max(0, (end - start) / b);
}

export function availability(buckets: SeriesBucket[], expectedBuckets: number): number | null {
  if (expectedBuckets <= 0) return null;
  const present = buckets.filter((b) => b.samples > 0).length;
  return Math.min(1, present / expectedBuckets);
}

export function dataCompleteness(
  buckets: SeriesBucket[],
  expectedBuckets: number,
  pollIntervalSec: number,
  bucketSec = KPI_BUCKET_SEC,
): number | null {
  if (expectedBuckets <= 0 || pollIntervalSec <= 0) return null;
  const perBucket = Math.max(1, Math.floor(bucketSec / pollIntervalSec));
  const got = buckets.reduce((s, b) => s + Math.min(b.samples, perBucket), 0);
  return Math.min(1, got / (expectedBuckets * perBucket));
}

export interface PrResult {
  performanceRatio: number | null;
  energyKwh: number;
  irradiationKwhM2: number;
  intervals: number;
}

export function performanceRatio(
  power: SeriesBucket[],
  irradiance: SeriesBucket[],
  peakKwp: number | null | undefined,
  powerKey = "activePowerKw",
  irrKey = "irradianceWm2",
  bucketSec = KPI_BUCKET_SEC,
): PrResult {
  const h = bucketSec / 3600;
  const irr = new Map(irradiance.map((b) => [b.bucketStartSec, b.values[irrKey]]));
  let e = 0;
  let hpoa = 0;
  let n = 0;
  for (const b of power) {
    const p = b.values[powerKey];
    const g = irr.get(b.bucketStartSec);
    if (p == null || g == null || !Number.isFinite(p) || !Number.isFinite(g)) continue;
    e += Math.max(0, p) * h;
    hpoa += (Math.max(0, g) / 1000) * h;
    n++;
  }
  const pr = peakKwp && peakKwp > 0 && hpoa > 0 ? e / (hpoa * peakKwp) : null;
  return { performanceRatio: pr, energyKwh: e, irradiationKwhM2: hpoa, intervals: n };
}

export interface DeviceKpis {
  meterId: number;
  from: string;
  to: string;
  availability: number | null;
  dataCompleteness: number | null;
  performanceRatio: number | null;
  energyKwh: number | null;
  irradiationKwhM2: number | null;
}

/** Energy-weighted site PR, mean availability/completeness. */
export function aggregateSite(devs: DeviceKpis[], peaks: Map<number, number | null>): {
  availability: number | null;
  dataCompleteness: number | null;
  performanceRatio: number | null;
} {
  const avg = (xs: Array<number | null>) => {
    const v = xs.filter((x): x is number => x !== null);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null;
  };
  let e = 0;
  let ref = 0;
  for (const d of devs) {
    const kwp = peaks.get(d.meterId);
    if (d.performanceRatio === null || !kwp || d.irradiationKwhM2 === null || d.energyKwh === null) continue;
    e += d.energyKwh;
    ref += d.irradiationKwhM2 * kwp;
  }
  return {
    availability: avg(devs.map((d) => d.availability)),
    dataCompleteness: avg(devs.map((d) => d.dataCompleteness)),
    performanceRatio: ref > 0 ? e / ref : null,
  };
}
