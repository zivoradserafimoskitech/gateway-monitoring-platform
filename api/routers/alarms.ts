import { z } from "zod";
import { and, eq, desc, isNull, or, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, authed, operator } from "../middleware";
import { getDb } from "../queries/connection";
import { alarms, alarmRules, meters, gateways } from "@db/schema";
import { invalidateRulesCache } from "../mqtt/handlers";
import { assertOrgWrite, isSuper, meterOrg, orgWhere, stampOrg } from "../lib/org-scope";
import type { User } from "@db/schema";

// v8/D2: the alarms table has no org_id of its own — scope through the
// meter's org, or the gateway's org for meter-less alarms (e.g. gateway offline).
function alarmOrgCond(user: User | null) {
  if (isSuper(user)) return undefined;
  const org = user!.orgId ?? -1;
  return or(eq(meters.orgId, org), and(isNull(alarms.meterId), eq(gateways.orgId, org)));
}

async function alarmOrg(id: number): Promise<number | null | undefined> {
  const db = getDb();
  const rows = await db
    .select({ meterOrg: meters.orgId, gatewayOrg: gateways.orgId })
    .from(alarms)
    .leftJoin(meters, eq(alarms.meterId, meters.id))
    .leftJoin(gateways, eq(alarms.gatewayId, gateways.id))
    .where(eq(alarms.id, id))
    .limit(1);
  if (!rows[0]) return undefined;
  return rows[0].meterOrg ?? rows[0].gatewayOrg;
}

async function assertRuleOrg(user: User | null, id: number): Promise<void> {
  const db = getDb();
  const rows = await db.select({ orgId: alarmRules.orgId }).from(alarmRules).where(eq(alarmRules.id, id)).limit(1);
  if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Rule not found" });
  assertOrgWrite(user, rows[0].orgId, "Rule");
}

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
    .query(async ({ input, ctx }) => {
      const db = getDb();
      const conds = [alarmOrgCond(ctx.user), input?.status ? eq(alarms.status, input.status) : undefined].filter(
        (c) => c !== undefined,
      );
      const rows = await db
        .select({ alarm: alarms, meterName: meters.name, gatewayName: gateways.name })
        .from(alarms)
        .leftJoin(meters, eq(alarms.meterId, meters.id))
        .leftJoin(gateways, eq(alarms.gatewayId, gateways.id))
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(alarms.triggeredAt))
        .limit(input?.limit ?? 100);
      return rows.map((r) => ({ ...r.alarm, meterName: r.meterName, gatewayName: r.gatewayName }));
    }),

  counts: authed.query(async ({ ctx }) => {
    const db = getDb();
    // #14: aggregate in SQL — the old version pulled EVERY alarm row into
    // memory on every dashboard poll.
    const rows = await db
      .select({ status: alarms.status, n: sql<number>`count(*)` })
      .from(alarms)
      .leftJoin(meters, eq(alarms.meterId, meters.id))
      .leftJoin(gateways, eq(alarms.gatewayId, gateways.id))
      .where(alarmOrgCond(ctx.user))
      .groupBy(alarms.status);
    const counts = { active: 0, acknowledged: 0, resolved: 0 };
    for (const r of rows) counts[r.status] = Number(r.n);
    return counts;
  }),

  acknowledge: operator.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    assertOrgWrite(ctx.user, await alarmOrg(input.id), "Alarm");
    const db = getDb();
    await db
      .update(alarms)
      .set({ status: "acknowledged", acknowledgedAt: new Date() })
      .where(eq(alarms.id, input.id));
    return { ok: true };
  }),

  resolve: operator.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    assertOrgWrite(ctx.user, await alarmOrg(input.id), "Alarm");
    const db = getDb();
    await db
      .update(alarms)
      .set({ status: "resolved", resolvedAt: new Date() })
      .where(eq(alarms.id, input.id));
    return { ok: true };
  }),

  // ─── Rules ─────────────────────────────────────────────────────────────
  listRules: authed.query(async ({ ctx }) => {
    const db = getDb();
    const rows = await db
      .select({ rule: alarmRules, meterName: meters.name })
      .from(alarmRules)
      .leftJoin(meters, eq(alarmRules.meterId, meters.id))
      .where(orgWhere(ctx.user, alarmRules.orgId))
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
    .mutation(async ({ input, ctx }) => {
      // v8/D2: a meter-bound rule must target a device in the caller's org.
      if (input.meterId != null) assertOrgWrite(ctx.user, await meterOrg(input.meterId), "Device");
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
          orgId: stampOrg(ctx.user),
        })
        .$returningId();
      invalidateRulesCache();
      return { ok: true, id: inserted[0].id };
    }),

  toggleRule: operator
    .input(z.object({ id: z.number(), enabled: z.boolean() }))
    .mutation(async ({ input, ctx }) => {
      await assertRuleOrg(ctx.user, input.id);
      const db = getDb();
      await db.update(alarmRules).set({ enabled: input.enabled }).where(eq(alarmRules.id, input.id));
      invalidateRulesCache();
      return { ok: true };
    }),

  deleteRule: operator.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    await assertRuleOrg(ctx.user, input.id);
    const db = getDb();
    await db.delete(alarmRules).where(eq(alarmRules.id, input.id));
    return { ok: true };
  }),
});
