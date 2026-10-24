// Fleet management: tags, groups and bulk config pushes.
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, authed, operator } from "../middleware";
import { getDb } from "../queries/connection";
import { gatewayGroupMembers, gatewayGroups, gateways } from "@db/schema";
import { assertOrgRead, assertOrgWrite, gatewayOrg, isSuper, orgWhere, stampOrg } from "../lib/org-scope";
import { normalizeTags, resolveSelection } from "../fleet/select";
import { createOtaJob } from "../ota/manager";

const bad = (e: unknown) => new TRPCError({ code: "BAD_REQUEST", message: e instanceof Error ? e.message : String(e) });

async function loadGroup(user: Parameters<typeof assertOrgWrite>[0], id: number, write: boolean) {
  const g = await getDb().select().from(gatewayGroups).where(eq(gatewayGroups.id, id)).limit(1);
  if (!g[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Group not found" });
  (write ? assertOrgWrite : assertOrgRead)(user, g[0].orgId, "Group");
  return g[0];
}

export const fleetRouter = createRouter({
  groups: authed.query(async ({ ctx }) => {
    const db = getDb();
    const groups = await db.select().from(gatewayGroups).where(orgWhere(ctx.user, gatewayGroups.orgId)).orderBy(gatewayGroups.name);
    const ids = groups.map((g) => g.id);
    const members = ids.length ? await db.select().from(gatewayGroupMembers).where(inArray(gatewayGroupMembers.groupId, ids)) : [];
    return groups.map((g) => ({ ...g, gatewayIds: members.filter((m) => m.groupId === g.id).map((m) => m.gatewayId) }));
  }),

  createGroup: operator
    .input(z.object({ name: z.string().min(1).max(128), description: z.string().max(500).optional() }))
    .mutation(async ({ ctx, input }) => {
      const ins = await getDb()
        .insert(gatewayGroups)
        .values({ name: input.name, description: input.description ?? null, orgId: stampOrg(ctx.user, null) })
        .$returningId();
      return { id: ins[0].id };
    }),

  deleteGroup: operator.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    await loadGroup(ctx.user, input.id, true);
    const db = getDb();
    await db.delete(gatewayGroupMembers).where(eq(gatewayGroupMembers.groupId, input.id));
    await db.delete(gatewayGroups).where(eq(gatewayGroups.id, input.id));
    return { ok: true };
  }),

  /** Replace a group's members. Gateways must be writable by the caller and in the group's org. */
  setMembers: operator
    .input(z.object({ groupId: z.number(), gatewayIds: z.array(z.number()).max(5000) }))
    .mutation(async ({ ctx, input }) => {
      const group = await loadGroup(ctx.user, input.groupId, true);
      const db = getDb();
      const ids = [...new Set(input.gatewayIds)];
      if (ids.length) {
        const rows = await db.select({ id: gateways.id, orgId: gateways.orgId }).from(gateways).where(inArray(gateways.id, ids));
        if (rows.length !== ids.length) throw new TRPCError({ code: "NOT_FOUND", message: "Unknown gateway in list" });
        for (const r of rows) {
          assertOrgWrite(ctx.user, r.orgId, "Gateway");
          if (!isSuper(ctx.user) && r.orgId !== group.orgId) throw new TRPCError({ code: "FORBIDDEN", message: "Gateway belongs to another org" });
        }
      }
      await db.delete(gatewayGroupMembers).where(eq(gatewayGroupMembers.groupId, input.groupId));
      if (ids.length) await db.insert(gatewayGroupMembers).values(ids.map((gatewayId) => ({ groupId: input.groupId, gatewayId })));
      return { ok: true, members: ids.length };
    }),

  setTags: operator.input(z.object({ gatewayId: z.number(), tags: z.array(z.string()).max(32) })).mutation(async ({ ctx, input }) => {
    assertOrgWrite(ctx.user, await gatewayOrg(input.gatewayId), "Gateway");
    let tags: string[];
    try {
      tags = normalizeTags(input.tags);
    } catch (e) {
      throw bad(e);
    }
    await getDb().update(gateways).set({ tags }).where(eq(gateways.id, input.gatewayId));
    return { tags };
  }),

  /** Preview which gateways a selector hits (no side effects). */
  resolve: authed
    .input(z.object({ groupId: z.number().optional(), tags: z.array(z.string()).max(16).optional(), gatewayIds: z.array(z.number()).max(5000).optional() }))
    .query(async ({ ctx, input }) => resolveFor(ctx.user, input)),

  /** Queue the same config push (OTA "config" job) on every selected gateway. */
  bulkConfig: operator
    .input(
      z.object({
        groupId: z.number().optional(),
        tags: z.array(z.string()).max(16).optional(),
        gatewayIds: z.array(z.number()).max(5000).optional(),
        payload: z.record(z.string(), z.unknown()),
        confirmCount: z.number().int(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const ids = await resolveFor(ctx.user, input);
      // The caller states how many gateways they expect to touch; a mismatch
      // (fleet changed, wrong tag) aborts instead of pushing to a surprise set.
      if (ids.length !== input.confirmCount) {
        throw new TRPCError({ code: "CONFLICT", message: `Selection matches ${ids.length} gateways, not ${input.confirmCount}` });
      }
      const rows = await getDb().select({ id: gateways.id, orgId: gateways.orgId }).from(gateways).where(inArray(gateways.id, ids.length ? ids : [-1]));
      for (const r of rows) assertOrgWrite(ctx.user, r.orgId, "Gateway");
      const jobs: { gatewayId: number; jobId: number; status: string }[] = [];
      for (const gatewayId of ids) {
        const job = await createOtaJob({ gatewayId, type: "config", payload: input.payload, createdBy: ctx.user?.id ?? null });
        jobs.push({ gatewayId, jobId: job.id, status: job.status });
      }
      return { queued: jobs.length, jobs };
    }),
});

async function resolveFor(
  user: Parameters<typeof orgWhere>[0],
  sel: { groupId?: number; tags?: string[]; gatewayIds?: number[] },
): Promise<number[]> {
  const db = getDb();
  const visible = await db.select({ id: gateways.id, tags: gateways.tags }).from(gateways).where(orgWhere(user, gateways.orgId));
  let groupMemberIds: number[] | undefined;
  if (sel.groupId !== undefined) {
    await loadGroup(user, sel.groupId, false);
    groupMemberIds = (
      await db.select({ id: gatewayGroupMembers.gatewayId }).from(gatewayGroupMembers).where(and(eq(gatewayGroupMembers.groupId, sel.groupId)))
    ).map((r) => r.id);
  }
  try {
    return resolveSelection(visible, { gatewayIds: sel.gatewayIds, groupMemberIds, tags: sel.tags });
  } catch (e) {
    throw bad(e);
  }
}
