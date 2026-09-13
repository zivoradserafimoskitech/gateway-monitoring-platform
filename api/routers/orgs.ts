// v8/D2: organization management — superadmin only (see middleware.superadmin).
// Device/site reassignment between orgs is deliberately NOT exposed here yet;
// the probe does it via direct SQL. If needed later, add reassign procedures
// with the same guard.
import { z } from "zod";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { createRouter, admin, superadmin } from "../middleware";
import { getDb } from "../queries/connection";
import { deviceRegistrations, gateways, meters, orgs, sites, users } from "@db/schema";
import { evictUserCache } from "../lib/auth";
import { evictGatewayCache } from "../mqtt/service";
import { assertRowOrg, isSuper, orgWhere, siteOrg, stampOrg } from "../lib/org-scope";

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
  // ─── Pre-registered devices ────────────────────────────────────────────────
  // §1.4: the half of the null-org fix that needs no broker configuration.
  // Ingestion is a shared MQTT subscription, so the broker's authenticated
  // publisher identity never reaches us. Serial numbers, however, are known
  // before hardware ships — registering the UID in advance means the gateway
  // is stamped with the right tenant the moment it first publishes, and never
  // passes through the unclaimed queue at all.
  //
  // admin, not superadmin: registering a device for YOUR OWN org is ordinary
  // commissioning work. Only a superadmin may register one into another org,
  // which is what stampOrg already enforces.

  registrations: admin.query(async ({ ctx }) => {
    const db = getDb();
    const rows = await db
      .select({ reg: deviceRegistrations, orgName: orgs.name, siteName: sites.name })
      .from(deviceRegistrations)
      .leftJoin(orgs, eq(deviceRegistrations.orgId, orgs.id))
      .leftJoin(sites, eq(deviceRegistrations.siteId, sites.id))
      .where(orgWhere(ctx.user, deviceRegistrations.orgId))
      .orderBy(desc(deviceRegistrations.createdAt));
    return rows.map((r) => ({ ...r.reg, orgName: r.orgName, siteName: r.siteName }));
  }),

  registerDevice: admin
    .input(
      z.object({
        uid: z.string().min(1).max(64),
        orgId: z.number().optional(), // superadmin only; others get their own org
        siteId: z.number().nullable().optional(),
        note: z.string().max(255).optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      const db = getDb();
      const uid = input.uid.trim();
      if (!uid) throw new TRPCError({ code: "BAD_REQUEST", message: "UID is required" });
      // A non-superadmin cannot register into someone else's org: stampOrg
      // ignores the explicit value for them.
      const orgId = stampOrg(ctx.user, input.orgId);
      if (orgId === null) {
        throw new TRPCError({ code: "BAD_REQUEST", message: "An organization is required" });
      }
      const o = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.id, orgId)).limit(1);
      if (!o[0]) throw new TRPCError({ code: "NOT_FOUND", message: `Organization ${orgId} not found` });
      if (input.siteId != null) {
        // The site must belong to the same tenant, or the device would arrive
        // at a site its own org cannot see.
        const so = await siteOrg(input.siteId);
        if (so === undefined) throw new TRPCError({ code: "NOT_FOUND", message: "Site not found" });
        if (so !== orgId && !isSuper(ctx.user)) {
          throw new TRPCError({ code: "FORBIDDEN", message: "Site belongs to another organization" });
        }
      }
      // The gateway may already exist — registering after the fact is the
      // natural thing to try, so make it work rather than fail confusingly.
      const existing = await db
        .select({ id: gateways.id, orgId: gateways.orgId })
        .from(gateways)
        .where(eq(gateways.uid, uid))
        .limit(1);
      if (existing[0] && existing[0].orgId !== null) {
        throw new TRPCError({
          code: "CONFLICT",
          message: "That gateway already belongs to an organization — use a claim, not a registration",
        });
      }
      const dup = await db
        .select({ id: deviceRegistrations.id })
        .from(deviceRegistrations)
        .where(eq(deviceRegistrations.uid, uid))
        .limit(1);
      if (dup[0]) throw new TRPCError({ code: "CONFLICT", message: `${uid} is already registered` });

      const inserted = await db
        .insert(deviceRegistrations)
        .values({
          uid,
          orgId,
          siteId: input.siteId ?? null,
          note: input.note?.trim() || null,
          createdBy: ctx.user?.id ?? null,
        })
        .$returningId();

      // If the hardware beat the paperwork, apply it now instead of waiting
      // for a device that has already announced itself to announce itself again.
      let claimedNow = false;
      if (existing[0]) {
        await db
          .update(gateways)
          .set({ orgId, ...(input.siteId != null ? { siteId: input.siteId } : {}) })
          .where(eq(gateways.id, existing[0].id));
        await db
          .update(meters)
          .set({ orgId })
          .where(and(eq(meters.gatewayId, existing[0].id), isNull(meters.orgId)));
        await db
          .update(deviceRegistrations)
          .set({ claimedAt: new Date(), gatewayId: existing[0].id })
          .where(eq(deviceRegistrations.id, inserted[0].id));
        evictGatewayCache(uid);
        claimedNow = true;
      }
      return { id: inserted[0].id, claimedNow };
    }),

  removeRegistration: admin.input(z.object({ id: z.number() })).mutation(async ({ ctx, input }) => {
    const db = getDb();
    const rows = await db
      .select({ orgId: deviceRegistrations.orgId })
      .from(deviceRegistrations)
      .where(eq(deviceRegistrations.id, input.id))
      .limit(1);
    if (!rows[0]) throw new TRPCError({ code: "NOT_FOUND", message: "Registration not found" });
    assertRowOrg(ctx.user, rows[0].orgId, "Registration");
    // Deleting a registration does NOT un-assign a gateway that already
    // arrived: the device is provisioned and owned at that point, and taking
    // its org away would make it vanish from the tenant that is using it.
    await db.delete(deviceRegistrations).where(eq(deviceRegistrations.id, input.id));
    return { ok: true };
  }),
});
