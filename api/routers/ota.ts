// v8/D5: OTA job CRUD — operator-gated mutations (audit rows free via the
// RBAC middleware). list is any-authenticated. cancel only works while pending.
import { z } from "zod";
import { desc, eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, authed, operator } from "../middleware";
import { getDb } from "../queries/connection";
import {
  firmwareReleases,
  gateways,
  otaJobs,
  otaRolloutTargets,
  otaRollouts,
} from "@db/schema";
import { cancelOtaJob, createOtaJob } from "../ota/manager";
import { assertOrgWrite, isSuper, orgWhere, stampOrg } from "../lib/org-scope";
import { planBatches, rolloutProgress } from "../ota/rollout";
import { parseEgressUrl, BlockedEgressError } from "../lib/egress";
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

  // ─── §9.9: firmware releases and staged rollouts ───────────────────────────
  // A rollout points at a REGISTERED release rather than at a URL somebody
  // typed into the form, so "which bytes did we ship" still has an answer
  // months later when the question is asked by someone holding a device that
  // no longer boots.
  releases: authed.query(async ({ ctx }) => {
    return getDb()
      .select()
      .from(firmwareReleases)
      .where(orgWhere(ctx.user, firmwareReleases.orgId))
      .orderBy(desc(firmwareReleases.createdAt));
  }),

  createRelease: operator
    .input(
      z.object({
        model: z.string().min(1).max(128),
        version: z.string().min(1).max(64),
        url: z.string().min(1).max(1000),
        // Optional but strongly wanted: the gateway verifies before flashing.
        sha256: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
        notes: z.string().max(1000).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        parseEgressUrl(input.url);
      } catch (e) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: e instanceof BlockedEgressError ? e.message : "The firmware URL must be a valid URL",
        });
      }
      const inserted = await getDb()
        .insert(firmwareReleases)
        .values({
          model: input.model,
          version: input.version,
          url: input.url,
          sha256: input.sha256?.toLowerCase() ?? null,
          notes: input.notes ?? null,
          createdBy: ctx.user?.id ?? null,
          orgId: stampOrg(ctx.user, null),
        })
        .$returningId();
      return { id: inserted[0].id };
    }),

  rollouts: authed.query(async ({ ctx }) => {
    const db = getDb();
    const rows = await db
      .select({ rollout: otaRollouts, model: firmwareReleases.model, version: firmwareReleases.version })
      .from(otaRollouts)
      .leftJoin(firmwareReleases, eq(otaRollouts.releaseId, firmwareReleases.id))
      .where(orgWhere(ctx.user, otaRollouts.orgId))
      .orderBy(desc(otaRollouts.createdAt))
      .limit(50);
    // Progress is computed from the target rows rather than stored on the
    // rollout: one number that can disagree with the rows it summarises is a
    // number somebody will eventually act on.
    const withProgress = await Promise.all(
      rows.map(async (r) => {
        const targets = await db
          .select({ status: otaRolloutTargets.status, batchIndex: otaRolloutTargets.batchIndex, gatewayId: otaRolloutTargets.gatewayId })
          .from(otaRolloutTargets)
          .where(eq(otaRolloutTargets.rolloutId, r.rollout.id));
        return {
          ...r.rollout,
          model: r.model,
          version: r.version,
          progress: rolloutProgress(targets),
        };
      }),
    );
    return withProgress;
  }),

  createRollout: operator
    .input(
      z.object({
        releaseId: z.number(),
        name: z.string().min(1).max(255),
        // Either an explicit list, or every gateway of the release's model.
        gatewayIds: z.array(z.number()).max(5000).optional(),
        canaryCount: z.number().int().min(1).max(50).default(1),
        batchSize: z.number().int().min(1).max(500).default(10),
        failureThresholdPct: z.number().int().min(0).max(100).default(10),
        // Created paused by default: a fleet firmware update should be started
        // by somebody who meant to start it, not by having filled in a form.
        start: z.boolean().default(false),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const rel = await db.select().from(firmwareReleases).where(eq(firmwareReleases.id, input.releaseId)).limit(1);
      if (!rel[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Firmware release not found" });
      assertOrgWrite(ctx.user, rel[0].orgId, "Firmware release");

      const visible = orgWhere(ctx.user, gateways.orgId);
      const candidates = await db
        .select({ id: gateways.id, orgId: gateways.orgId })
        .from(gateways)
        .where(visible)
        .orderBy(gateways.id);
      const allowed = new Set(candidates.map((g) => g.id));
      const chosen = input.gatewayIds?.length
        ? input.gatewayIds.filter((id) => allowed.has(id))
        : candidates.map((g) => g.id);
      if (chosen.length === 0) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "No gateways in scope for this rollout" });
      }
      for (const g of candidates) {
        if (chosen.includes(g.id)) assertOrgWrite(ctx.user, g.orgId, "Gateway");
      }

      const inserted = await db
        .insert(otaRollouts)
        .values({
          releaseId: input.releaseId,
          name: input.name,
          canaryCount: input.canaryCount,
          batchSize: input.batchSize,
          failureThresholdPct: input.failureThresholdPct,
          status: input.start ? "running" : "draft",
          startedAt: input.start ? new Date() : null,
          createdBy: ctx.user?.id ?? null,
          orgId: isSuper(ctx.user) ? rel[0].orgId : stampOrg(ctx.user, null),
        })
        .$returningId();
      const rolloutId = inserted[0].id;

      // Membership is frozen HERE, not re-derived each sweep: a gateway that
      // comes online halfway through must not silently join a wave that has
      // already been judged.
      const plan = planBatches(chosen, input.canaryCount, input.batchSize);
      await db.insert(otaRolloutTargets).values(
        plan.map((t) => ({ rolloutId, gatewayId: t.gatewayId, batchIndex: t.batchIndex, status: t.status })),
      );
      return { id: rolloutId, targets: plan.length, batches: new Set(plan.map((t) => t.batchIndex)).size };
    }),

  setRolloutStatus: operator
    .input(z.object({ id: z.number(), status: z.enum(["running", "paused"]) }))
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const rows = await db.select().from(otaRollouts).where(eq(otaRollouts.id, input.id)).limit(1);
      if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Rollout not found" });
      assertOrgWrite(ctx.user, rows[0].orgId, "Rollout");
      // A halted rollout is not resumed by flipping it back to running: it
      // stopped because a wave failed, and the fix is a new release and a new
      // rollout, not another pass over the same image.
      if (rows[0].status === "halted") {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "This rollout halted on a failed batch. Register a fixed release and start a new rollout.",
        });
      }
      if (rows[0].status === "completed") {
        throw new TRPCError({ code: "BAD_REQUEST", message: "This rollout is already complete" });
      }
      await db
        .update(otaRollouts)
        .set({ status: input.status, startedAt: rows[0].startedAt ?? (input.status === "running" ? new Date() : null) })
        .where(eq(otaRollouts.id, input.id));
      return { ok: true };
    }),

  rolloutTargets: authed.input(z.object({ id: z.number() })).query(async ({ ctx, input }) => {
    const db = getDb();
    const rows = await db.select({ orgId: otaRollouts.orgId }).from(otaRollouts).where(eq(otaRollouts.id, input.id)).limit(1);
    if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Rollout not found" });
    if (!isSuper(ctx.user) && rows[0].orgId !== (ctx.user?.orgId ?? -1)) {
      throw new TRPCError({ code: "NOT_FOUND", message: "Rollout not found" });
    }
    return db
      .select({
        gatewayId: otaRolloutTargets.gatewayId,
        gatewayName: gateways.name,
        batchIndex: otaRolloutTargets.batchIndex,
        status: otaRolloutTargets.status,
        error: otaRolloutTargets.error,
        updatedAt: otaRolloutTargets.updatedAt,
      })
      .from(otaRolloutTargets)
      .leftJoin(gateways, eq(otaRolloutTargets.gatewayId, gateways.id))
      .where(eq(otaRolloutTargets.rolloutId, input.id))
      .orderBy(otaRolloutTargets.batchIndex, otaRolloutTargets.gatewayId);
  }),
});
