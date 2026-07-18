import { z } from "zod";
import { eq } from "drizzle-orm";
import { createRouter, publicQuery } from "../middleware";
import { getDb } from "../queries/connection";
import { meters, gateways, sites } from "@db/schema";
import { getTelemetryStore } from "../telemetry";

export const reportsRouter = createRouter({
  energy: publicQuery
    .input(
      z.object({
        scope: z.enum(["meter", "site"]),
        meterId: z.number().optional(),
        siteId: z.number().optional(),
        from: z.date(),
        to: z.date(),
      }),
    )
    .query(async ({ input }) => {
      const db = getDb();
      let meterFilter: number[] = [];
      let scopeLabel = "";

      if (input.scope === "meter") {
        if (!input.meterId) throw new Error("meterId is required for meter scope");
        const m = await db.select().from(meters).where(eq(meters.id, input.meterId)).limit(1);
        if (!m[0]) throw new Error("Meter not found");
        meterFilter = [input.meterId];
        scopeLabel = m[0].name;
      } else {
        if (!input.siteId) throw new Error("siteId is required for site scope");
        const s = await db.select().from(sites).where(eq(sites.id, input.siteId)).limit(1);
        if (!s[0]) throw new Error("Site not found");
        const rows = await db
          .select({ id: meters.id })
          .from(meters)
          .innerJoin(gateways, eq(meters.gatewayId, gateways.id))
          .where(eq(gateways.siteId, input.siteId));
        meterFilter = rows.map((r) => r.id);
        scopeLabel = s[0].name;
      }

      const perMeter = [];
      for (const id of meterFilter) {
        const m = await db.select().from(meters).where(eq(meters.id, id)).limit(1);
        const days = await getTelemetryStore().dailyReport(id, input.from, input.to);
        const totalImport = days.reduce((s, d) => s + (d.importKwh ?? 0), 0);
        const totalExport = days.reduce((s, d) => s + (d.exportKwh ?? 0), 0);
        const maxDemand = days.reduce((s, d) => Math.max(s, d.maxDemandKw ?? 0), 0);
        perMeter.push({
          meter: m[0],
          days,
          totalImportKwh: Math.round(totalImport * 100) / 100,
          totalExportKwh: Math.round(totalExport * 100) / 100,
          maxDemandKw: Math.round(maxDemand * 100) / 100,
        });
      }

      return {
        scope: input.scope,
        scopeLabel,
        from: input.from,
        to: input.to,
        meters: perMeter,
        totalImportKwh: Math.round(perMeter.reduce((s, m) => s + m.totalImportKwh, 0) * 100) / 100,
        totalExportKwh: Math.round(perMeter.reduce((s, m) => s + m.totalExportKwh, 0) * 100) / 100,
      };
    }),
});
