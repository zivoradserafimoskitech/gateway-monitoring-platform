// v8/D2: organization management — superadmin only (see middleware.superadmin).
// Device/site reassignment between orgs is deliberately NOT exposed here yet;
// the probe does it via direct SQL. If needed later, add reassign procedures
// with the same guard.
import { z } from "zod";
import { and, eq, isNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, superadmin } from "../middleware";
import { getDb } from "../queries/connection";
import { gateways, meters, orgs, sites, users } from "@db/schema";
import { evictUserCache } from "../lib/auth";

export const orgsRouter = createRouter({
  list: superadmin.query(async () => {
    const db = getDb();
    const rows = await db.select().from(orgs).orderBy(orgs.id);
    const counts = await Promise.all(
      rows.map(async (o) => {
        const [u, s, g, m] = await Promise.all([
          db.select({ n: sql<number>`count(*)` }).from(users).where(eq(users.orgId, o.id)),
          db.select({ n: sql<number>`count(*)` }).from(sites).where(eq(sites.orgId, o.id)),
          db.select({ n: sql<number>`count(*)` }).from(gateways).where(eq(gateways.orgId, o.id)),
          db.select({ n: sql<number>`count(*)` }).from(meters).where(eq(meters.orgId, o.id)),
        ]);
        return { users: Number(u[0]?.n ?? 0), sites: Number(s[0]?.n ?? 0), gateways: Number(g[0]?.n ?? 0), devices: Number(m[0]?.n ?? 0) };
      }),
    );
    return rows.map((o, i) => ({ ...o, counts: counts[i] }));
  }),

  create: superadmin.input(z.object({ name: z.string().min(1).max(255) })).mutation(async ({ input }) => {
    const db = getDb();
    const existing = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.name, input.name)).limit(1);
    if (existing[0]) throw new TRPCError({ code: "CONFLICT", message: "Organization name already exists" });
    const res = await db.insert(orgs).values({ name: input.name }).$returningId();
    return { id: res[0].id };
  }),

  assignUser: superadmin
    .input(z.object({ userId: z.number(), orgId: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const o = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, input.orgId)).limit(1);
      if (!o[0]) throw new TRPCError({ code: "NOT_FOUND", message: `Organization ${input.orgId} not found` });
      const u = await db.select({ id: users.id, isSuperadmin: users.isSuperadmin }).from(users).where(eq(users.id, input.userId)).limit(1);
      if (!u[0]) throw new TRPCError({ code: "NOT_FOUND", message: `User ${input.userId} not found` });
      if (u[0].isSuperadmin) throw new TRPCError({ code: "BAD_REQUEST", message: "Cannot reassign the superadmin's home org" });
      await db.update(users).set({ orgId: input.orgId }).where(eq(users.id, input.userId));
      evictUserCache(); // org change must take effect within the cache TTL
      return { ok: true };
    }),

  // ─── Unclaimed devices ─────────────────────────────────────────────────────
  // MQTT auto-provisioning creates a gateway (and its meters) the first time
  // hardware speaks, before anyone has said which tenant it belongs to, so the
  // rows land with org_id NULL. Under org scoping a NULL-org device is
  // invisible to every tenant — the hardware keeps ingesting into a database
  // nobody can see, which looks exactly like a device that never connected.
  //
  // The full fix derives the tenant from a broker-authenticated client identity
  // and needs broker configuration. This is the part that does not: make the
  // limbo explicit and give a superadmin one action to end it.

  unclaimedDevices: superadmin.query(async () => {
    const db = getDb();
    const [gws, mtrs] = await Promise.all([
      db.select().from(gateways).where(isNull(gateways.orgId)).orderBy(gateways.lastSeenAt),
      db
        .select({
          id: meters.id,
          name: meters.name,
          model: meters.model,
          deviceType: meters.deviceType,
          gatewayId: meters.gatewayId,
          status: meters.status,
          lastSeenAt: meters.lastSeenAt,
        })
        .from(meters)
        .where(isNull(meters.orgId))
        .orderBy(meters.lastSeenAt),
    ]);
    return {
      gateways: gws,
      devices: mtrs,
      total: gws.length + mtrs.length,
    };
  }),

  claimGateway: superadmin
    .input(z.object({ gatewayId: z.number(), orgId: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const o = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, input.orgId)).limit(1);
      if (!o[0]) throw new TRPCError({ code: "NOT_FOUND", message: `Organization ${input.orgId} not found` });
      const g = await db
        .select({ id: gateways.id, orgId: gateways.orgId })
        .from(gateways)
        .where(eq(gateways.id, input.gatewayId))
        .limit(1);
      if (!g[0]) throw new TRPCError({ code: "NOT_FOUND", message: `Gateway ${input.gatewayId} not found` });
      if (g[0].orgId !== null) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Gateway already belongs to an organization — use a reassignment, not a claim",
        });
      }
      await db.update(gateways).set({ orgId: input.orgId }).where(eq(gateways.id, input.gatewayId));
      // Claim the gateway's own unclaimed meters with it: they arrived through
      // the same uplink and belong to the same tenant. Meters already assigned
      // to an org are left alone.
      const claimed = await db
        .update(meters)
        .set({ orgId: input.orgId })
        .where(and(eq(meters.gatewayId, input.gatewayId), isNull(meters.orgId)));
      const head = Array.isArray(claimed) ? claimed[0] : claimed;
      const devices = Number((head as { affectedRows?: number } | undefined)?.affectedRows ?? 0);
      return { ok: true, devices };
    }),

  claimDevice: superadmin
    .input(z.object({ meterId: z.number(), orgId: z.number() }))
    .mutation(async ({ input }) => {
      const db = getDb();
      const o = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, input.orgId)).limit(1);
      if (!o[0]) throw new TRPCError({ code: "NOT_FOUND", message: `Organization ${input.orgId} not found` });
      const m = await db
        .select({ id: meters.id, orgId: meters.orgId })
        .from(meters)
        .where(eq(meters.id, input.meterId))
        .limit(1);
      if (!m[0]) throw new TRPCError({ code: "NOT_FOUND", message: `Device ${input.meterId} not found` });
      if (m[0].orgId !== null) {
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "Device already belongs to an organization — use a reassignment, not a claim",
        });
      }
      await db.update(meters).set({ orgId: input.orgId }).where(eq(meters.id, input.meterId));
      return { ok: true };
    }),
});
