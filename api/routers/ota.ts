// v8/D5: OTA job CRUD — operator-gated mutations (audit rows free via the
// RBAC middleware). list is any-authenticated. cancel only works while pending.
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, authed, operator } from "../middleware";
import { getDb } from "../queries/connection";
import { gateways, otaJobs } from "@db/schema";
import { cancelOtaJob, createOtaJob } from "../ota/manager";
import { assertOrgWrite, orgWhere } from "../lib/org-scope";
import { and } from "drizzle-orm";

export const otaRouter = createRouter({
  list: authed.input(z.object({ gatewayId: z.number() })).query(async ({ input, ctx }) => {
    const db = getDb();
    return db
      .select()
      .from(otaJobs)
      .where(and(eq(otaJobs.gatewayId, input.gatewayId), orgWhere(ctx.user, otaJobs.orgId)))
      .orderBy(desc(otaJobs.id))
      .limit(100);
  }),

  create: operator
    .input(
      z.object({
        gatewayId: z.number(),
        type: z.enum(["firmware", "config"]),
        payload: z.record(z.string(), z.unknown()),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const db = getDb();
      const gw = await db.select({ id: gateways.id, orgId: gateways.orgId }).from(gateways).where(eq(gateways.id, input.gatewayId)).limit(1);
      if (!gw[0]) throw new TRPCError({ code: "NOT_FOUND", message: `Gateway ${input.gatewayId} not found` });
      assertOrgWrite(ctx.user, gw[0].orgId, "Gateway"); // v8/D2
      return createOtaJob({ gatewayId: input.gatewayId, type: input.type, payload: input.payload, createdBy: ctx.user?.id ?? null });
    }),

  cancel: operator.input(z.object({ id: z.number() })).mutation(async ({ input, ctx }) => {
    // v8/D2: job rows carry org_id (stamped at creation via the gateway's org).
    const rows = await getDb().select({ orgId: otaJobs.orgId }).from(otaJobs).where(eq(otaJobs.id, input.id)).limit(1);
    if (rows[0]) assertOrgWrite(ctx.user, rows[0].orgId, "Job");
    const res = await cancelOtaJob(input.id);
    if ("error" in res) throw new TRPCError({ code: "BAD_REQUEST", message: res.error });
    return res;
  }),
});
