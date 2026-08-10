// v8/D1: EMS tRPC — operator-guarded CRUD for BESS schedules and peak-shaving
// configs; any authenticated user can read the recent automatic command feed
// (system commands: kind=control, userId null). Mutation audit rows come free
// via the RBAC middleware.
import { z } from "zod";
import { and, desc, eq, isNull } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, authed, operator } from "../middleware";
import { getDb } from "../queries/connection";
import { commands, emsPeakShaving, emsSchedules, meters } from "@db/schema";

async function assertMeter(id: number): Promise<void> {
  const rows = await getDb().select({ id: meters.id }).from(meters).where(eq(meters.id, id)).limit(1);
  if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: `Device ${id} not found` });
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
    list: authed.input(z.object({ meterId: z.number().optional() })).query(async ({ input }) => {
      const db = getDb();
      const base = db.select().from(emsSchedules).orderBy(emsSchedules.id);
      return input.meterId != null
        ? db.select().from(emsSchedules).where(eq(emsSchedules.meterId, input.meterId)).orderBy(emsSchedules.id)
        : base;
    }),

    create: operator.input(scheduleInput).mutation(async ({ input, ctx }) => {
      await assertMeter(input.meterId);
      const db = getDb();
      const res = await db.insert(emsSchedules).values({ ...input, createdBy: ctx.user?.id ?? null }).$returningId();
      return { id: res[0].id };
    }),

    update: operator
      .input(z.object({ id: z.number(), patch: scheduleInput.partial().omit({ meterId: true }) }))
      .mutation(async ({ input }) => {
        const db = getDb();
        const res = await db.update(emsSchedules).set(input.patch).where(eq(emsSchedules.id, input.id));
        if ((res[0] as { affectedRows?: number }).affectedRows === 0) {
          throw new TRPCError({ code: "NOT_FOUND", message: `Schedule ${input.id} not found` });
        }
        return { ok: true };
      }),

    remove: operator.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
      const db = getDb();
      await db.delete(emsSchedules).where(eq(emsSchedules.id, input.id));
      return { ok: true };
    }),
  }),

  peakShaving: createRouter({
    list: authed
      .input(z.object({ bessMeterId: z.number().optional() }))
      .query(async ({ input }) => {
        const db = getDb();
        return input.bessMeterId != null
          ? db.select().from(emsPeakShaving).where(eq(emsPeakShaving.bessMeterId, input.bessMeterId)).orderBy(emsPeakShaving.id)
          : db.select().from(emsPeakShaving).orderBy(emsPeakShaving.id);
      }),

    create: operator.input(peakInput).mutation(async ({ input }) => {
      await assertMeter(input.sourceMeterId);
      await assertMeter(input.bessMeterId);
      const db = getDb();
      const res = await db.insert(emsPeakShaving).values(input).$returningId();
      return { id: res[0].id };
    }),

    update: operator
      .input(z.object({ id: z.number(), patch: peakInput.partial() }))
      .mutation(async ({ input }) => {
        const db = getDb();
        const res = await db.update(emsPeakShaving).set(input.patch).where(eq(emsPeakShaving.id, input.id));
        if ((res[0] as { affectedRows?: number }).affectedRows === 0) {
          throw new TRPCError({ code: "NOT_FOUND", message: `Peak-shaving config ${input.id} not found` });
        }
        return { ok: true };
      }),

    remove: operator.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
      const db = getDb();
      await db.delete(emsPeakShaving).where(eq(emsPeakShaving.id, input.id));
      return { ok: true };
    }),
  }),

  // Recent automatic (system) commands — controller decisions land in the same
  // commands audit table as manual control, distinguishable by userId null.
  autoCommands: authed
    .input(z.object({ meterId: z.number().optional(), limit: z.number().min(1).max(100).default(20) }))
    .query(async ({ input }) => {
      const db = getDb();
      const where = input.meterId != null
        ? and(eq(commands.kind, "control"), isNull(commands.userId), eq(commands.meterId, input.meterId))
        : and(eq(commands.kind, "control"), isNull(commands.userId));
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
});
