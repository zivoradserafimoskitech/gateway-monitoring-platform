// Technical KPIs (availability, performance ratio, data completeness).
import { z } from "zod";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, authed, operator } from "../middleware";
import { getDb } from "../queries/connection";
import { meters, sites } from "@db/schema";
import { assertOrgRead, assertOrgWrite, meterOrg, siteOrg } from "../lib/org-scope";
import { deviceKpis, KPI_MAX_RANGE_MS, siteKpis } from "../kpi/service";

const range = z
  .object({ from: z.coerce.date(), to: z.coerce.date() })
  .refine((r) => r.to > r.from && r.to.getTime() - r.from.getTime() <= KPI_MAX_RANGE_MS, "range must be positive and at most 93 days");

export const kpisRouter = createRouter({
  device: authed.input(z.object({ meterId: z.number() }).and(range)).query(async ({ ctx, input }) => {
    assertOrgRead(ctx.user, await meterOrg(input.meterId), "Device");
    const k = await deviceKpis(input.meterId, input.from, input.to);
    if (!k) throw new TRPCError({ code: "NOT_FOUND", message: "Device not found" });
    return k;
  }),

  site: authed.input(z.object({ siteId: z.number() }).and(range)).query(async ({ ctx, input }) => {
    assertOrgRead(ctx.user, await siteOrg(input.siteId), "Site");
    return siteKpis(input.siteId, input.from, input.to);
  }),

  setPeakPower: operator.input(z.object({ meterId: z.number(), peakPowerKwp: z.number().positive().max(100_000).nullable() })).mutation(async ({ ctx, input }) => {
    assertOrgWrite(ctx.user, await meterOrg(input.meterId), "Device");
    await getDb().update(meters).set({ peakPowerKwp: input.peakPowerKwp }).where(eq(meters.id, input.meterId));
    return { ok: true };
  }),

  setIrradianceMeter: operator.input(z.object({ siteId: z.number(), meterId: z.number().nullable() })).mutation(async ({ ctx, input }) => {
    assertOrgWrite(ctx.user, await siteOrg(input.siteId), "Site");
    if (input.meterId !== null) assertOrgWrite(ctx.user, await meterOrg(input.meterId), "Device");
    await getDb().update(sites).set({ irradianceMeterId: input.meterId }).where(eq(sites.id, input.siteId));
    return { ok: true };
  }),
});
