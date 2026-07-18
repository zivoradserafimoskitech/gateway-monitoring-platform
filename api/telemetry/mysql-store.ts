// MySQL telemetry store — keeps telemetry in the same database as metadata.
// Suitable for small fleets (dev, pilots, up to ~50 gateways at 1 min reporting).
// For 300–500 gateways use the TimescaleDB store.
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/mysql2";
import { getDb } from "../queries/connection";
import * as schema from "@db/schema";
import { telemetry } from "@db/schema";
import type {
  DailyReportRow,
  HistoryPoint,
  TelemetryRow,
  TelemetryStore,
  TrendPoint,
} from "./types";

type WriteDb = ReturnType<typeof drizzle<typeof schema>>;
let writeDb: WriteDb | null = null;

// The batched hot path gets its OWN small connection pool, so bursts of
// metadata work (auto-provisioning, UI queries) can never starve telemetry
// writes of connections.
function getWriteDb(): WriteDb {
  if (!writeDb) {
    writeDb = drizzle({
      connection: {
        uri: process.env.DATABASE_URL!,
        connectionLimit: 4,
        enableKeepAlive: true,
      },
      schema,
      mode: "planetscale",
    });
  }
  return writeDb;
}

export class MySqlTelemetryStore implements TelemetryStore {
  async writeBatch(rows: TelemetryRow[]): Promise<void> {
    if (rows.length === 0) return;
    const db = getWriteDb();
    await db.insert(telemetry).values(
      rows.map((r) => ({
        meterId: r.meterId,
        ts: r.ts,
        voltageL1: r.values.voltageL1 ?? null,
        voltageL2: r.values.voltageL2 ?? null,
        voltageL3: r.values.voltageL3 ?? null,
        currentL1: r.values.currentL1 ?? null,
        currentL2: r.values.currentL2 ?? null,
        currentL3: r.values.currentL3 ?? null,
        activePowerKw: r.values.activePowerKw ?? null,
        reactivePowerKvar: r.values.reactivePowerKvar ?? null,
        apparentPowerKva: r.values.apparentPowerKva ?? null,
        powerFactor: r.values.powerFactor ?? null,
        frequencyHz: r.values.frequencyHz ?? null,
        energyImportKwh: r.values.energyImportKwh ?? null,
        energyExportKwh: r.values.energyExportKwh ?? null,
        demandKw: r.values.demandKw ?? null,
        raw: (r.raw ?? null) as Record<string, unknown> | null,
      })),
    );
  }

  async latest(meterId: number): Promise<TelemetryRow | null> {
    const db = getDb();
    const rows = await db
      .select()
      .from(telemetry)
      .where(eq(telemetry.meterId, meterId))
      .orderBy(desc(telemetry.ts))
      .limit(1);
    const r = rows[0];
    if (!r) return null;
    return {
      meterId: r.meterId,
      ts: r.ts,
      values: {
        voltageL1: r.voltageL1 ?? undefined,
        voltageL2: r.voltageL2 ?? undefined,
        voltageL3: r.voltageL3 ?? undefined,
        currentL1: r.currentL1 ?? undefined,
        currentL2: r.currentL2 ?? undefined,
        currentL3: r.currentL3 ?? undefined,
        activePowerKw: r.activePowerKw ?? undefined,
        reactivePowerKvar: r.reactivePowerKvar ?? undefined,
        apparentPowerKva: r.apparentPowerKva ?? undefined,
        powerFactor: r.powerFactor ?? undefined,
        frequencyHz: r.frequencyHz ?? undefined,
        energyImportKwh: r.energyImportKwh ?? undefined,
        energyExportKwh: r.energyExportKwh ?? undefined,
        demandKw: r.demandKw ?? undefined,
      },
    };
  }

  async latestAll(): Promise<Map<number, TelemetryRow>> {
    const db = getDb();
    // Set-based "latest per meter": the GROUP BY uses a loose index scan on
    // (meter_id, ts), the join fetches one row per meter — scales to millions.
    const res = await db.execute(sql`
      select t.meter_id, t.ts, t.active_power_kw, t.energy_import_kwh
      from telemetry t
      inner join (
        select meter_id, max(ts) as mx from telemetry group by meter_id
      ) x on x.meter_id = t.meter_id and x.mx = t.ts
    `);
    const map = new Map<number, TelemetryRow>();
    for (const row of res[0] as unknown as Array<Record<string, unknown>>) {
      const meterId = Number(row.meter_id);
      map.set(meterId, {
        meterId,
        ts: new Date(row.ts as string),
        values: {
          activePowerKw: row.active_power_kw === null ? undefined : Number(row.active_power_kw),
          energyImportKwh: row.energy_import_kwh === null ? undefined : Number(row.energy_import_kwh),
        },
      });
    }
    return map;
  }

  async history(meterId: number, from: Date, to: Date, bucketSec: number): Promise<HistoryPoint[]> {
    const db = getDb();
    const rows = await db
      .select({
        bucket: sql<number>`floor(unix_timestamp(${telemetry.ts}) / ${bucketSec}) * ${bucketSec}`.as("bucket"),
        activePowerKw: sql<number>`avg(${telemetry.activePowerKw})`.as("activePowerKw"),
        voltageL1: sql<number>`avg(${telemetry.voltageL1})`.as("voltageL1"),
        currentL1: sql<number>`avg(${telemetry.currentL1})`.as("currentL1"),
        powerFactor: sql<number>`avg(${telemetry.powerFactor})`.as("powerFactor"),
        frequencyHz: sql<number>`avg(${telemetry.frequencyHz})`.as("frequencyHz"),
        energyImportKwh: sql<number>`max(${telemetry.energyImportKwh})`.as("energyImportKwh"),
        samples: sql<number>`count(*)`.as("samples"),
      })
      .from(telemetry)
      .where(and(eq(telemetry.meterId, meterId), gte(telemetry.ts, from), lte(telemetry.ts, to)))
      .groupBy(sql`bucket`)
      .orderBy(sql`bucket`);
    return rows.map((r) => ({
      ts: new Date(Number(r.bucket) * 1000),
      activePowerKw: r.activePowerKw === null ? null : Number(r.activePowerKw),
      voltageL1: r.voltageL1 === null ? null : Number(r.voltageL1),
      currentL1: r.currentL1 === null ? null : Number(r.currentL1),
      powerFactor: r.powerFactor === null ? null : Number(r.powerFactor),
      frequencyHz: r.frequencyHz === null ? null : Number(r.frequencyHz),
      energyImportKwh: r.energyImportKwh === null ? null : Number(r.energyImportKwh),
      samples: Number(r.samples),
    }));
  }

  async powerTrend(from: Date, bucketSec: number): Promise<TrendPoint[]> {
    const db = getDb();
    const rows = await db
      .select({
        bucket: sql<number>`floor(unix_timestamp(${telemetry.ts}) / ${bucketSec}) * ${bucketSec}`.as("bucket"),
        meterId: telemetry.meterId,
        avgKw: sql<number>`avg(${telemetry.activePowerKw})`.as("avgKw"),
      })
      .from(telemetry)
      .where(gte(telemetry.ts, from))
      .groupBy(sql`bucket`, telemetry.meterId)
      .orderBy(sql`bucket`);
    return rows.map((r) => ({
      bucketSec: Number(r.bucket),
      meterId: r.meterId,
      avgKw: r.avgKw === null ? null : Number(r.avgKw),
    }));
  }

  async firstEnergySince(meterId: number, from: Date): Promise<number | null> {
    const db = getDb();
    const rows = await db
      .select({ v: telemetry.energyImportKwh })
      .from(telemetry)
      .where(and(eq(telemetry.meterId, meterId), gte(telemetry.ts, from)))
      .orderBy(telemetry.ts)
      .limit(1);
    return rows[0]?.v ?? null;
  }

  async firstEnergyAll(since: Date): Promise<Map<number, number>> {
    const db = getDb();
    const res = await db.execute(sql`
      select t.meter_id, t.energy_import_kwh
      from telemetry t
      inner join (
        select meter_id, min(ts) as mn from telemetry where ts >= ${since} group by meter_id
      ) x on x.meter_id = t.meter_id and x.mn = t.ts
    `);
    const map = new Map<number, number>();
    for (const row of res[0] as unknown as Array<Record<string, unknown>>) {
      if (row.energy_import_kwh !== null) map.set(Number(row.meter_id), Number(row.energy_import_kwh));
    }
    return map;
  }

  async dailyReport(meterId: number, from: Date, to: Date): Promise<DailyReportRow[]> {
    const db = getDb();
    const rows = await db
      .select({
        day: sql<string>`date_format(${telemetry.ts}, '%Y-%m-%d')`.as("day"),
        eMin: sql<number>`min(${telemetry.energyImportKwh})`.as("eMin"),
        eMax: sql<number>`max(${telemetry.energyImportKwh})`.as("eMax"),
        xMin: sql<number>`min(${telemetry.energyExportKwh})`.as("xMin"),
        xMax: sql<number>`max(${telemetry.energyExportKwh})`.as("xMax"),
        maxDemand: sql<number>`max(coalesce(${telemetry.demandKw}, ${telemetry.activePowerKw}))`.as("maxDemand"),
        avgPf: sql<number>`avg(${telemetry.powerFactor})`.as("avgPf"),
        samples: sql<number>`count(*)`.as("samples"),
      })
      .from(telemetry)
      .where(and(eq(telemetry.meterId, meterId), gte(telemetry.ts, from), lte(telemetry.ts, to)))
      .groupBy(sql`day`)
      .orderBy(sql`day`);
    return rows.map((r) => ({
      day: r.day,
      importKwh:
        r.eMin === null || r.eMax === null ? null : Math.round((Number(r.eMax) - Number(r.eMin)) * 100) / 100,
      exportKwh:
        r.xMin === null || r.xMax === null ? null : Math.round((Number(r.xMax) - Number(r.xMin)) * 100) / 100,
      maxDemandKw: r.maxDemand === null ? null : Math.round(Number(r.maxDemand) * 100) / 100,
      avgPowerFactor: r.avgPf === null ? null : Math.round(Number(r.avgPf) * 1000) / 1000,
      samples: Number(r.samples),
    }));
  }

  async close(): Promise<void> {
    // MySQL pool lifecycle is owned by api/queries/connection
  }
}
