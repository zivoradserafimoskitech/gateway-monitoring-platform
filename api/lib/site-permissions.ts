// DB side of per-site permissions: load a user's site grants (cached briefly)
// and enforce one permission on one site from a tRPC procedure.
import { eq } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "../queries/connection";
import { gateways, meters, siteRoles } from "@db/schema";
import type { User } from "@db/schema";
import { can, type Permission, type SiteGrant } from "./permissions";

const TTL_MS = 30_000;
const cache = new Map<number, { at: number; grants: SiteGrant[] }>();

export function evictSiteGrants(userId?: number): void {
  if (userId === undefined) cache.clear();
  else cache.delete(userId);
}

export async function siteGrantsFor(userId: number): Promise<SiteGrant[]> {
  const hit = cache.get(userId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.grants;
  const rows = await getDb()
    .select({ siteId: siteRoles.siteId, role: siteRoles.role, extra: siteRoles.extra })
    .from(siteRoles)
    .where(eq(siteRoles.userId, userId));
  const grants = rows.map((r) => ({ siteId: r.siteId, role: r.role, extra: Array.isArray(r.extra) ? (r.extra as SiteGrant["extra"]) : null }));
  cache.set(userId, { at: Date.now(), grants });
  return grants;
}

/** Site of a device: its own site, else its gateway's. */
export async function meterSiteId(meterId: number): Promise<number | null> {
  const db = getDb();
  const m = await db.select({ siteId: meters.siteId, gatewayId: meters.gatewayId }).from(meters).where(eq(meters.id, meterId)).limit(1);
  if (!m[0]) return null;
  if (m[0].siteId != null) return m[0].siteId;
  const g = await db.select({ siteId: gateways.siteId }).from(gateways).where(eq(gateways.id, m[0].gatewayId)).limit(1);
  return g[0]?.siteId ?? null;
}

/** FORBIDDEN unless the user holds `perm` on `siteId`. Open demo mode (no user) passes. */
export async function requireSitePermission(user: User | null, siteId: number | null, perm: Permission): Promise<void> {
  if (!user) return;
  const grants = await siteGrantsFor(user.id);
  if (!can(user, siteId, perm, grants)) {
    throw new TRPCError({ code: "FORBIDDEN", message: `Missing permission '${perm}' for this site` });
  }
}
