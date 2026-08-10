import { z } from "zod";
import { eq, desc, sql } from "drizzle-orm";
import { createRouter, authed, operator } from "../middleware";
import { getDb } from "../queries/connection";
import { alarms, alarmRules, meters, gateways } from "@db/schema";
import { invalidateRulesCache } from "../mqtt/handlers";

export const alarmsRouter = createRouter({
  list: authed
    .input(
      z
        .object({
          status: z.enum(["active", "acknowledged", "resolved"]).optional(),
          limit: z.number().int().min(1).max(500).default(100),
        })
        .optional(),
    )
    .query(async ({ input }) => {
      const db = getDb();
      const base = db
        .select({ alarm: alarms, meterName: meters.name, gatewayName: gateways.name })
        .from(alarms)
        .leftJoin(meters, eq(alarms.meterId, meters.id))
        .leftJoin(gateways, eq(alarms.gatewayId, gateways.id))
        .orderBy(desc(alarms.triggeredAt))
        .limit(input?.limit ?? 100);
      const rows = input?.status ? await base.where(eq(alarms.status, input.status)) : await base;
      return rows.map((r) => ({ ...r.alarm, meterName: r.meterName, gatewayName: r.gatewayName }));
    }),

  counts: authed.query(async () => {
    const db = getDb();
    // #14: aggregate in SQL — the old version pulled EVERY alarm row into
    // memory on every dashboard poll.
    const rows = await db
      .select({ status: alarms.status, n: sql<number>`count(*)` })
      .from(alarms)
      .groupBy(alarms.status);
    const counts = { active: 0, acknowledged: 0, resolved: 0 };
    for (const r of rows) counts[r.status] = Number(r.n);
    return counts;
  }),

  acknowledge: operator.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    await db
      .update(alarms)
      .set({ status: "acknowledged", acknowledgedAt: new Date() })
      .where(eq(alarms.id, input.id));
    return { ok: true };
  }),

  resolve: operator.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    await db
      .update(alarms)
      .set({ status: "resolved", resolvedAt: new Date() })
      .where(eq(alarms.id, input.id));
    return { ok: true };
  }),

  // ─── Rules ─────────────────────────────────────────────────────────────
  listRules: authed.query(async () => {
    const db = getDb();
    const rows = await db
      .select({ rule: alarmRules, meterName: meters.name })
      .from(alarmRules)
      .leftJoin(meters, eq(alarmRules.meterId, meters.id))
      .orderBy(desc(alarmRules.createdAt));
    return rows.map((r) => ({ ...r.rule, meterName: r.meterName }));
  }),

  createRule: operator
    .input(
      z.object({
        name: z.string().min(1).max(255),
        // #19: open key space — profiles define far more keys than ALARM_METRICS
        // (e.g. ESMU socPercent/bmsStatusCode). Evaluation simply skips metrics
        // a device doesn't report, so any non-empty key is valid here.
        metric: z.string().min(1).max(100),
        operator: z.enum(["gt", "lt"]),
        threshold: z.number(),
        severity: z.enum(["info", "warning", "critical"]).default("warning"),
        meterId: z.number().nullable().optional(),
      }),
    )
    .mutation(async ({ input }) => {
      const db = getDb();
      const inserted = await db
        .insert(alarmRules)
        .values({
          name: input.name,
          metric: input.metric,
          operator: input.operator,
          threshold: input.threshold,
          severity: input.severity,
          meterId: input.meterId ?? null,
        })
        .$returningId();
      invalidateRulesCache();
      return { ok: true, id: inserted[0].id };
    }),

  toggleRule: operator
    .input(z.object({ id: z.number(), enabled: z.boolean() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      await db.update(alarmRules).set({ enabled: input.enabled }).where(eq(alarmRules.id, input.id));
      invalidateRulesCache();
      return { ok: true };
    }),

  deleteRule: operator.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    await db.delete(alarmRules).where(eq(alarmRules.id, input.id));
    return { ok: true };
  }),
});
