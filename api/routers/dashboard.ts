import { z } from "zod";
import { eq, desc } from "drizzle-orm";
import { createRouter, authed } from "../middleware";
import { getDb } from "../queries/connection";
import { gateways, meters, alarms, sites } from "@db/schema";
import { getTelemetryStore } from "../telemetry";
import { PRIMARY_POWER_KEY, ENERGY_COUNTER_KEY } from "@contracts/devices";
import type { DeviceType } from "@contracts/devices";

interface Overview {
  gatewaysOnline: number;
  gatewaysTotal: number;
  metersOnline: number;
  metersTotal: number;
  activeAlarms: number;
  sitesTotal: number;
  totalPowerKw: number;
  energyTodayKwh: number;
}

// Overview aggregates across the whole fleet — cache briefly so dashboard
// polling (5 s × many open tabs) doesn't multiply fleet-wide scans.
let overviewCache: { at: number; data: Overview } | null = null;

export const dashboardRouter = createRouter({
  overview: authed.query(async () => {
    if (overviewCache && Date.now() - overviewCache.at < 10_000) return overviewCache.data;

    const db = getDb();
    const store = getTelemetryStore();
    // #8: "today" is the UTC calendar day everywhere (was server-local midnight).
    const dayStart = new Date(Math.floor(Date.now() / 86_400_000) * 86_400_000);

    // Set-based fleet summaries — constant query count regardless of fleet size.
    const [gwRows, meterRows, alarmRows, siteRows, latestByMeter, firstEnergyByMeter] =
      await Promise.all([
        db.select().from(gateways),
        db.select().from(meters),
        db.select().from(alarms).where(eq(alarms.status, "active")),
        db.select().from(sites),
        store.latestAll(),
        store.firstEnergyAll(dayStart),
      ]);

    let totalPowerKw = 0;
    let energyTodayKwh = 0;
    for (const m of meterRows) {
      const latest = latestByMeter.get(m.id);
      // #13: follow the device-type contracts — a BESS contributes battery
      // power and discharge energy, not the meter-column defaults.
      const dt = m.deviceType as DeviceType;
      const pk = PRIMARY_POWER_KEY[dt] ?? "activePowerKw";
      const ek = ENERGY_COUNTER_KEY[dt] ?? "energyImportKwh";
      if (latest?.values[pk] != null && m.status === "online") {
        totalPowerKw += latest.values[pk];
      }
      const first = firstEnergyByMeter.get(m.id);
      if (latest?.values[ek] != null && first != null) {
        // v7/C7: counter reset/meter swap today → counter now sits BELOW the
        // day's first reading; the post-reset reading itself is the best
        // estimate of today's production (clamping to 0 would hide it).
        const v = latest.values[ek];
        energyTodayKwh += v >= first ? v - first : v;
      }
    }

    const data: Overview = {
      gatewaysOnline: gwRows.filter((g) => g.status === "online").length,
      gatewaysTotal: gwRows.length,
      metersOnline: meterRows.filter((m) => m.status === "online").length,
      metersTotal: meterRows.length,
      activeAlarms: alarmRows.length,
      sitesTotal: siteRows.length,
      totalPowerKw: Math.round(totalPowerKw * 100) / 100,
      energyTodayKwh: Math.round(energyTodayKwh * 100) / 100,
    };
    overviewCache = { at: Date.now(), data };
    return data;
  }),

  // Fleet-wide power trend: store returns per-meter bucket averages,
  // we sum across meters per bucket here.
  powerTrend: authed
    .input(z.object({ hours: z.number().min(1).max(168).default(24) }).optional())
    .query(async ({ input }) => {
      const hours = input?.hours ?? 24;
      const from = new Date(Date.now() - hours * 3600_000);
      const bucketSec = Math.max(60, Math.floor((hours * 3600) / 120));
      const rows = await getTelemetryStore().powerTrend(from, bucketSec);
      const byBucket = new Map<number, number>();
      for (const r of rows) {
        if (r.avgKw === null) continue;
        byBucket.set(r.bucketSec, (byBucket.get(r.bucketSec) ?? 0) + r.avgKw);
      }
      return [...byBucket.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([bucket, powerKw]) => ({
          ts: new Date(bucket * 1000),
          powerKw: Math.round(powerKw * 100) / 100,
        }));
    }),

  recentAlarms: authed.query(async () => {
    const db = getDb();
    const rows = await db
      .select({ alarm: alarms, meterName: meters.name, gatewayName: gateways.name })
      .from(alarms)
      .leftJoin(meters, eq(alarms.meterId, meters.id))
      .leftJoin(gateways, eq(alarms.gatewayId, gateways.id))
      .orderBy(desc(alarms.triggeredAt))
      .limit(8);
    return rows.map((r) => ({ ...r.alarm, meterName: r.meterName, gatewayName: r.gatewayName }));
  }),
});
