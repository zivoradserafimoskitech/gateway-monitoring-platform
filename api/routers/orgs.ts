// v8/D2: organization management — superadmin only (see middleware.superadmin).
// Device/site reassignment between orgs is deliberately NOT exposed here yet;
// the probe does it via direct SQL. If needed later, add reassign procedures
// with the same guard.
import { z } from "zod";
import { eq, sql } from "drizzle-orm";
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
});
