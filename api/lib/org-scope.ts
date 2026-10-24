// v8/D2: multi-tenancy scoping helpers.
//
// Model: users.orgId = home org; users.isSuperadmin sees ALL orgs. In open
// demo mode (AUTH_REQUIRED=false, ctx.user null) everything is unrestricted —
// scoping is fully transparent for superadmin and demo mode so existing
// probes keep working unchanged.
//
// Reads: lists add orgWhere(ctx.user, table.orgId); by-id reads use 404
// (NOT_FOUND) for foreign-org rows so existence isn't leaked.
// Mutations: target row's orgId must match the caller's org → 403 FORBIDDEN;
// creations stamp orgId = caller's org (superadmin may pass orgId explicitly).
import { eq, inArray, type SQL, type Column } from "drizzle-orm";
import { TRPCError } from "@trpc/server";
import { getDb } from "../queries/connection";
import { gateways, meters, sites, users } from "@db/schema";
import type { User } from "@db/schema";
import { hasChildren, subtree } from "./org-tree";

/**
 * Orgs the caller may act on: the home org, plus its whole subtree when the
 * home org is an installer / O&M parent (api/lib/org-tree.ts).
 */
export function accessibleOrgIds(user: User): number[] {
  const home = user.orgId ?? -1;
  return home >= 0 && hasChildren(home) ? subtree(home) : [home];
}

function inScope(user: User, org: number | null | undefined): boolean {
  return org !== null && org !== undefined && accessibleOrgIds(user).includes(org);
}

export function isSuper(user: User | null | undefined): boolean {
  if (!user) return true; // open demo mode
  return user.isSuperadmin === true || (user.isSuperadmin as unknown) === 1;
}

/** WHERE fragment: undefined for superadmin (no filter), else eq(column, org). */
export function orgWhere(user: User | null, column: Column): SQL | undefined {
  if (isSuper(user)) return undefined;
  const ids = accessibleOrgIds(user!);
  return ids.length === 1 ? eq(column, ids[0]) : inArray(column, ids);
}

/** Org to stamp on newly created rows (superadmin may override explicitly). */
export function stampOrg(user: User | null, explicit?: number | null): number | null {
  if (!user) return explicit ?? null;
  if (isSuper(user)) return explicit ?? user.orgId ?? null;
  return user.orgId ?? null;
}

/** 403 when the row's org differs from the caller's (mutations). */
export function assertRowOrg(user: User | null, rowOrgId: number | null, what = "Resource"): void {
  if (isSuper(user)) return;
  if (!inScope(user!, rowOrgId)) {
    throw new TRPCError({ code: "FORBIDDEN", message: `${what} belongs to another organization` });
  }
}

/** 404 when the row doesn't exist or belongs to another org (by-id reads). */
export function assertRowOrgRead<T extends { orgId: number | null } | null | undefined>(user: User | null, row: T, what = "Resource"): asserts row is NonNullable<T> {
  if (!row) throw new TRPCError({ code: "NOT_FOUND", message: `${what} not found` });
  if (!isSuper(user) && !inScope(user!, row.orgId)) {
    throw new TRPCError({ code: "NOT_FOUND", message: `${what} not found` });
  }
}

// ─── Typed fetch helpers for the hot checks ──────────────────────────────────
export async function meterOrg(id: number): Promise<number | null | undefined> {
  const rows = await getDb().select({ orgId: meters.orgId }).from(meters).where(eq(meters.id, id)).limit(1);
  return rows[0] ? rows[0].orgId : undefined;
}

export async function gatewayOrg(id: number): Promise<number | null | undefined> {
  const rows = await getDb().select({ orgId: gateways.orgId }).from(gateways).where(eq(gateways.id, id)).limit(1);
  return rows[0] ? rows[0].orgId : undefined;
}

export async function siteOrg(id: number): Promise<number | null | undefined> {
  const rows = await getDb().select({ orgId: sites.orgId }).from(sites).where(eq(sites.id, id)).limit(1);
  return rows[0] ? rows[0].orgId : undefined;
}

/** Read-guard by id: 404 when missing or foreign org. */
export function assertOrgRead(user: User | null, org: number | null | undefined, what: string): void {
  if (org === undefined) throw new TRPCError({ code: "NOT_FOUND", message: `${what} not found` });
  if (!isSuper(user) && !inScope(user!, org)) {
    throw new TRPCError({ code: "NOT_FOUND", message: `${what} not found` });
  }
}

/** Mutation-guard by id: 404 when missing, 403 when foreign org. */
export function assertOrgWrite(user: User | null, org: number | null | undefined, what: string): void {
  if (org === undefined) throw new TRPCError({ code: "NOT_FOUND", message: `${what} not found` });
  if (!isSuper(user) && !inScope(user!, org)) {
    throw new TRPCError({ code: "FORBIDDEN", message: `${what} belongs to another organization` });
  }
}

export async function userOrg(id: number): Promise<number | null | undefined> {
  const rows = await getDb().select({ orgId: users.orgId }).from(users).where(eq(users.id, id)).limit(1);
  return rows[0] ? rows[0].orgId : undefined;
}
