// Loads telemetry for the technical KPIs (api/kpi/technical.ts).
import { and, eq, isNotNull } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { gateways, meters, sites } from "@db/schema";
import { getTelemetryStore } from "../telemetry";
import { aggregateSite, availability, bucketsBetween, dataCompleteness, KPI_BUCKET_SEC, performanceRatio, type DeviceKpis } from "./technical";

export const KPI_MAX_RANGE_MS = 93 * 86_400_000;

async function siteOfMeter(m: { siteId: number | null; gatewayId: number }): Promise<number | null> {
  if (m.siteId != null) return m.siteId;
  const g = await getDb().select({ siteId: gateways.siteId }).from(gateways).where(eq(gateways.id, m.gatewayId)).limit(1);
  return g[0]?.siteId ?? null;
}

export async function deviceKpis(meterId: number, from: Date, to: Date): Promise<DeviceKpis | null> {
  const db = getDb();
  const rows = await db.select().from(meters).where(eq(meters.id, meterId)).limit(1);
  const m = rows[0];
  if (!m) return null;
  const store = getTelemetryStore();
  const series = await store.metricSeries(meterId, from, to, KPI_BUCKET_SEC, ["activePowerKw"]);
  const expected = bucketsBetween(from.getTime(), to.getTime());
  let pr: ReturnType<typeof performanceRatio> | null = null;
  if (m.deviceType === "inverter" && m.peakPowerKwp) {
    const siteId = await siteOfMeter(m);
    const s = siteId != null ? await db.select({ irr: sites.irradianceMeterId }).from(sites).where(eq(sites.id, siteId)).limit(1) : [];
    const irrMeter = s[0]?.irr ?? null;
    if (irrMeter != null) {
      const irr = await store.metricSeries(irrMeter, from, to, KPI_BUCKET_SEC, ["irradianceWm2"]);
      pr = performanceRatio(series, irr, m.peakPowerKwp);
    }
  }
  return {
    meterId,
    from: from.toISOString(),
    to: to.toISOString(),
    availability: availability(series, expected),
    dataCompleteness: dataCompleteness(series, expected, m.pollIntervalSec ?? 60),
    performanceRatio: pr?.performanceRatio ?? null,
    energyKwh: pr ? pr.energyKwh : null,
    irradiationKwhM2: pr ? pr.irradiationKwhM2 : null,
  };
}

export async function siteKpis(siteId: number, from: Date, to: Date) {
  const db = getDb();
  const direct = await db.select({ id: meters.id, kwp: meters.peakPowerKwp }).from(meters).where(eq(meters.siteId, siteId));
  const viaGw = await db
    .select({ id: meters.id, kwp: meters.peakPowerKwp })
    .from(meters)
    .innerJoin(gateways, eq(meters.gatewayId, gateways.id))
    .where(and(eq(gateways.siteId, siteId), isNotNull(meters.id)));
  const all = new Map<number, number | null>();
  for (const r of [...direct, ...viaGw]) all.set(r.id, r.kwp ?? null);
  const devices: DeviceKpis[] = [];
  for (const id of all.keys()) {
    const k = await deviceKpis(id, from, to);
    if (k) devices.push(k);
  }
  return { siteId, from: from.toISOString(), to: to.toISOString(), ...aggregateSite(devices, all), devices };
}
