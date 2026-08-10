// v8/D3: scheduled-report CRUD + runNow (operator-gated mutations; audit rows
// come free via the RBAC middleware). Wired as reports.schedules.
import { z } from "zod";
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, authed, operator } from "../middleware";
import { getDb } from "../queries/connection";
import { reportSchedules, sites } from "@db/schema";
import { runSchedule } from "../reports/scheduler";

const scheduleInput = z.object({
  siteId: z.number().nullable().optional(), // null = all sites (fleet report)
  name: z.string().min(1).max(255),
  frequency: z.enum(["daily", "weekly", "monthly"]),
  format: z.enum(["xlsx", "pdf"]),
  recipients: z.array(z.string().email().max(255)).min(1).max(20),
  hourLocal: z.number().int().min(0).max(23),
  enabled: z.boolean().optional(),
});

async function assertSite(siteId: number | null | undefined): Promise<void> {
  if (siteId == null) return;
  const rows = await getDb().select({ id: sites.id }).from(sites).where(eq(sites.id, siteId)).limit(1);
  if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: `Site ${siteId} not found` });
}

export const reportSchedulesRouter = createRouter({
  list: authed.query(async () => {
    const db = getDb();
    return db.select().from(reportSchedules).orderBy(reportSchedules.id);
  }),

  create: operator.input(scheduleInput).mutation(async ({ input, ctx }) => {
    await assertSite(input.siteId);
    const db = getDb();
    const res = await db
      .insert(reportSchedules)
      .values({ ...input, siteId: input.siteId ?? null, createdBy: ctx.user?.id ?? null })
      .$returningId();
    return { id: res[0].id };
  }),

  update: operator
    .input(z.object({ id: z.number(), patch: scheduleInput.partial() }))
    .mutation(async ({ input }) => {
      await assertSite(input.patch.siteId);
      const db = getDb();
      const res = await db.update(reportSchedules).set(input.patch).where(eq(reportSchedules.id, input.id));
      if ((res[0] as { affectedRows?: number }).affectedRows === 0) {
        throw new TRPCError({ code: "NOT_FOUND", message: `Schedule ${input.id} not found` });
      }
      return { ok: true };
    }),

  remove: operator.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    await db.delete(reportSchedules).where(eq(reportSchedules.id, input.id));
    return { ok: true };
  }),

  // Immediate generate + send over the CURRENT period to date (testing path).
  runNow: operator.input(z.object({ id: z.number() })).mutation(async ({ input }) => {
    const db = getDb();
    const rows = await db.select().from(reportSchedules).where(eq(reportSchedules.id, input.id)).limit(1);
    if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: `Schedule ${input.id} not found` });
    try {
      return await runSchedule(rows[0], { current: true });
    } catch (err) {
      throw new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: err instanceof Error ? err.message : String(err) });
    }
  }),
});
