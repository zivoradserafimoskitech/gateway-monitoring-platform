// v8/D1: EMS tRPC — operator-guarded CRUD for BESS schedules and peak-shaving
// configs; any authenticated user can read the recent automatic command feed
// (system commands: kind=control, userId null). Mutation audit rows come free
// via the RBAC middleware.
import { z } from "zod";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, authed, operator } from "../middleware";
import { getDb } from "../queries/connection";
import { commands, emsPeakShaving, emsPlans, emsSchedules, meters } from "@db/schema";
import { assertOrgWrite, isSuper, meterOrg, orgWhere, stampOrg } from "../lib/org-scope";
import type { User } from "@db/schema";

async function assertMeter(id: number): Promise<void> {
  const rows = await getDb().select({ id: meters.id }).from(meters).where(eq(meters.id, id)).limit(1);
  if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: `Device ${id} not found` });
}

/** v8/D2: schedule/config rows carry org_id — mutation guard (404/403). */
async function assertRowOrg(user: User | null, table: "schedules" | "peak", id: number): Promise<void> {
  const db = getDb();
  const rows =
    table === "schedules"
      ? await db.select({ orgId: emsSchedules.orgId }).from(emsSchedules).where(eq(emsSchedules.id, id)).limit(1)
      : await db.select({ orgId: emsPeakShaving.orgId }).from(emsPeakShaving).where(eq(emsPeakShaving.id, id)).limit(1);
  if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: `${table === "schedules" ? "Schedule" : "Config"} ${id} not found` });
  assertOrgWrite(user, rows[0].orgId, "Row");
}

/** Org-owned meter ids for scoping the auto-command feed (commands has no org_id). */
async function orgMeterIds(user: User | null): Promise<number[] | undefined> {
  if (isSuper(user)) return undefined;
  const rows = await getDb().select({ id: meters.id }).from(meters).where(eq(meters.orgId, user!.orgId ?? -1));
  return rows.map((r) => r.id);
}

const minutes = z.number().int().min(0).max(1440);

const scheduleInput = z.object({
  meterId: z.number(),
  name: z.string().min(1).max(255),
  dayOfWeekMask: z.number().int().min(1).max(127),
  startMin: minutes,
  endMin: minutes,
  mode: z.enum(["charge", "discharge", "idle"]),
  targetKw: z.number().finite().min(0).nullable().optional(),
  targetSoc: z.number().finite().min(0).max(100).nullable().optional(),
  enabled: z.boolean().optional(),
});

const peakInput = z.object({
  siteId: z.number().nullable().optional(),
  sourceMeterId: z.number(),
  bessMeterId: z.number(),
  thresholdKw: z.number().finite().min(0),
  hysteresisKw: z.number().finite().min(0).optional(),
  maxDischargeKw: z.number().finite().positive(),
  enabled: z.boolean().optional(),
});

export const emsRouter = createRouter({
  schedules: createRouter({
    list: authed.input(z.object({ meterId: z.number().optional() })).query(async ({ input, ctx }) => {
      const db = getDb();
      const conds = [orgWhere(ctx.user, emsSchedules.orgId), input.meterId != null ? eq(emsSchedules.meterId, input.meterId) : undefined].filter(
        (c) => c !== undefined,
      );
      return db
        .select()
        .from(emsSchedules)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(emsSchedules.id);
    }),

    create: operator.input(scheduleInput).mutation(async ({ input, ctx }) => {
      await assertMeter(input.meterId);
      assertOrgWrite(ctx.user, await meterOrg(input.meterId), "Device");
      const db = getDb();
      const res = await db.insert(emsSchedules).values({ ...input, createdBy: ctx.user?.id ?? null, orgId: stampOrg(ctx.user) }).$returningId();
      return { id: res[0].id };
    }),

    update: operator
      .input(z.object({ id: z.number(), patch: scheduleInput.partial().omit({ meterId: true }) }))
      .mutation(async ({ input, ctx }) => {
        await assertRowOrg(ctx.user, "schedules", input.id);
        const db = getDb();
        const res = await db.update(emsSchedules).set(input.patch).where(eq(emsSchedules.id, input.id));
        if ((res[0] as { affectedRows?: number }).affectedRows === 0) {
          throw new TRPCError({ code: "NOT_FOUND", message: `Schedule ${input.id} not found` });
        }
        return { ok: true };
      }),

    remove: operator.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
      await assertRowOrg(ctx.user, "schedules", input.id);
      const db = getDb();
      await db.delete(emsSchedules).where(eq(emsSchedules.id, input.id));
      return { ok: true };
    }),
  }),

  peakShaving: createRouter({
    list: authed
      .input(z.object({ bessMeterId: z.number().optional() }))
      .query(async ({ input, ctx }) => {
        const db = getDb();
        const conds = [orgWhere(ctx.user, emsPeakShaving.orgId), input.bessMeterId != null ? eq(emsPeakShaving.bessMeterId, input.bessMeterId) : undefined].filter(
          (c) => c !== undefined,
        );
        return db
          .select()
          .from(emsPeakShaving)
          .where(conds.length ? and(...conds) : undefined)
          .orderBy(emsPeakShaving.id);
      }),

    create: operator.input(peakInput).mutation(async ({ input, ctx }) => {
      await assertMeter(input.sourceMeterId);
      await assertMeter(input.bessMeterId);
      assertOrgWrite(ctx.user, await meterOrg(input.sourceMeterId), "Device");
      assertOrgWrite(ctx.user, await meterOrg(input.bessMeterId), "Device");
      const db = getDb();
      const res = await db.insert(emsPeakShaving).values({ ...input, orgId: stampOrg(ctx.user) }).$returningId();
      return { id: res[0].id };
    }),

    update: operator
      .input(z.object({ id: z.number(), patch: peakInput.partial() }))
      .mutation(async ({ input, ctx }) => {
        await assertRowOrg(ctx.user, "peak", input.id);
        const db = getDb();
        const res = await db.update(emsPeakShaving).set(input.patch).where(eq(emsPeakShaving.id, input.id));
        if ((res[0] as { affectedRows?: number }).affectedRows === 0) {
          throw new TRPCError({ code: "NOT_FOUND", message: `Peak-shaving config ${input.id} not found` });
        }
        return { ok: true };
      }),

    remove: operator.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
      await assertRowOrg(ctx.user, "peak", input.id);
      const db = getDb();
      await db.delete(emsPeakShaving).where(eq(emsPeakShaving.id, input.id));
      return { ok: true };
    }),
  }),

  // Recent automatic (system) commands — controller decisions land in the same
  // commands audit table as manual control, distinguishable by userId null.
  autoCommands: authed
    .input(z.object({ meterId: z.number().optional(), limit: z.number().min(1).max(100).default(20) }))
    .query(async ({ input, ctx }) => {
      const db = getDb();
      // v8/D2: commands has no org_id — scope through org-owned meter ids.
      const meterIds = await orgMeterIds(ctx.user);
      const where = and(
        eq(commands.kind, "control"),
        isNull(commands.userId),
        input.meterId != null ? eq(commands.meterId, input.meterId) : undefined,
        meterIds !== undefined ? (meterIds.length ? inArray(commands.meterId, meterIds) : eq(commands.meterId, -1)) : undefined,
      );
      return db
        .select({
          id: commands.id,
          meterId: commands.meterId,
          status: commands.status,
          controlKey: commands.controlKey,
          controlValue: commands.controlValue,
          result: commands.result,
          createdAt: commands.createdAt,
        })
        .from(commands)
        .where(where)
        .orderBy(desc(commands.createdAt))
        .limit(input.limit);
    }),

  // v9.1/B1: optimizer-pushed EMS plans (Contract A) — read-only UI access.
  // Org-scoped via emsPlans.org_id directly (plans carry org since 0013).
  plans: authed.input(z.object({ meterId: z.number(), limit: z.number().min(1).max(50).default(10) })).query(async ({ input, ctx }) => {
    const db = getDb();
    return db
      .select({
        id: emsPlans.id,
        meterId: emsPlans.meterId,
        source: emsPlans.source,
        validFrom: emsPlans.validFrom,
        validTo: emsPlans.validTo,
        setpoints: emsPlans.setpoints,
        status: emsPlans.status,
        createdAt: emsPlans.createdAt,
      })
      .from(emsPlans)
      .where(and(eq(emsPlans.meterId, input.meterId), orgWhere(ctx.user, emsPlans.orgId)))
      .orderBy(desc(emsPlans.validFrom))
      .limit(input.limit);
  }),
});
