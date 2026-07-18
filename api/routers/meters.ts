import { z } from "zod";
import { eq, desc, and } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { meters, gateways, telemetry, sites } from "@db/schema";
import { DEFAULT_METER_PHASES } from "@contracts/modbus";
import { getTelemetryStore } from "../telemetry";

export const metersRouter = createRouter({
  list: publicQuery.query(async () => {
    const db = getDb();
    const rows = await db
      .select({ meter: meters, gatewayName: gateways.name, gatewayUid: gateways.uid, siteName: sites.name })
      .from(meters)
      .leftJoin(gateways, eq(meters.gatewayId, gateways.id))
      .leftJoin(sites, eq(gateways.siteId, sites.id))
      .orderBy(desc(meters.createdAt));
    return rows.map((r) => ({
      ...r.meter,
      gatewayName: r.gatewayName,
      gatewayUid: r.gatewayUid,
      siteName: r.siteName,
    }));
  }),

  create: publicQuery
    .input(
      z.object({
        gatewayId: z.number(),
        name: z.string().min(1).max(255),
        model: z.enum(["SEM2250", "SEM3250", "PEM3000"]),
        modbusAddress: z.number().int().min(1).max(247),
        channel: z.number().int().min(1).max(2).default(1),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const dup = await db
        .select()
        .from(meters)
        .where(and(eq(meters.gatewayId, input.gatewayId), eq(meters.modbusAddress, input.modbusAddress)))
        .limit(1);
      if (dup[0]) throw new Error("A meter with this Modbus address already exists on the gateway");
      const inserted = await db
        .insert(meters)
        .values({
          gatewayId: input.gatewayId,
          name: input.name,
          model: input.model,
          phases: DEFAULT_METER_PHASES[input.model],
          modbusAddress: input.modbusAddress,
          channel: input.channel,
        })
        .$returningId();
      const rows = await db.select().from(meters).where(eq(meters.id, inserted[0].id)).limit(1);
      return rows[0];
    }),

  update: publicQuery
    .input(
      z.object({
        id: z.number(),
        name: z.string().min(1).max(255).optional(),
        model: z.enum(["SEM2250", "SEM3250", "PEM3000"]).optional(),
        modbusAddress: z.number().int().min(1).max(247).optional(),
        channel: z.number().int().min(1).max(2).optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const { id, ...patch } = input;
      if (patch.model) {
        (patch as Record<string, unknown>).phases = DEFAULT_METER_PHASES[patch.model];
      }
      await db.update(meters).set(patch).where(eq(meters.id, id));
      const rows = await db.select().from(meters).where(eq(meters.id, id)).limit(1);
      return rows[0];
    }),

  remove: publicQuery.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    await db.delete(telemetry).where(eq(telemetry.meterId, input.id));
    await db.delete(meters).where(eq(meters.id, input.id));
    return { ok: true };
  }),

  latest: publicQuery.input(z.object({ meterId: z.number() })).query(async ({ input }) => {
    const row = await getTelemetryStore().latest(input.meterId);
    if (!row) return null;
    // Shape-compatible with the old telemetry table row the frontend expects
    return {
      meterId: row.meterId,
      ts: row.ts,
      voltageL1: row.values.voltageL1 ?? null,
      voltageL2: row.values.voltageL2 ?? null,
      voltageL3: row.values.voltageL3 ?? null,
      currentL1: row.values.currentL1 ?? null,
      currentL2: row.values.currentL2 ?? null,
      currentL3: row.values.currentL3 ?? null,
      activePowerKw: row.values.activePowerKw ?? null,
      reactivePowerKvar: row.values.reactivePowerKvar ?? null,
      apparentPowerKva: row.values.apparentPowerKva ?? null,
      powerFactor: row.values.powerFactor ?? null,
      frequencyHz: row.values.frequencyHz ?? null,
      energyImportKwh: row.values.energyImportKwh ?? null,
      energyExportKwh: row.values.energyExportKwh ?? null,
      demandKw: row.values.demandKw ?? null,
    };
  }),

  history: publicQuery
    .input(
      z.object({
        meterId: z.number(),
        from: z.date(),
        to: z.date(),
        buckets: z.number().int().min(10).max(500).default(120),
      }),
    )
    .query(async ({ input }) => {
      const spanSec = Math.max(60, Math.floor((input.to.getTime() - input.from.getTime()) / 1000));
      const bucketSec = Math.max(10, Math.floor(spanSec / input.buckets));
      return getTelemetryStore().history(input.meterId, input.from, input.to, bucketSec);
    }),
});
