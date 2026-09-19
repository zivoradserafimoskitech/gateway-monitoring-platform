// §9.11: invite decisions, kept pure so the rules that decide who gets an
// account are tests rather than a reading of the router.
//
// The token itself is generated and hashed here (both one-liners over
// node:crypto) and stored only as a hash — like a session token and an API
// key. A database dump must not hand somebody the ability to create accounts
// in every tenant with an invite outstanding.
import { createHash, randomBytes } from "node:crypto";

/** How long an invite stays usable. */
export const INVITE_TTL_DAYS = parseInt(process.env.ORG_INVITE_TTL_DAYS || "7", 10);

export function newInviteToken(): string {
  return randomBytes(32).toString("hex");
}

export function inviteTokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function inviteExpiryFrom(now: Date = new Date(), ttlDays: number = INVITE_TTL_DAYS): Date {
  // At least an hour, at most 90 days. A zero-day invite cannot be accepted by
  // anybody, and an indefinite one is a credential with no owner.
  const days = Number.isFinite(ttlDays) && ttlDays >= 1 ? Math.min(90, Math.floor(ttlDays)) : 7;
  return new Date(now.getTime() + days * 86_400_000);
}

export interface InviteRow {
  expiresAt: Date;
  acceptedAt: Date | null;
  revokedAt: Date | null;
}

export type InviteState = "usable" | "expired" | "accepted" | "revoked";

/**
 * Why an invite cannot be used, or that it can.
 *
 * The order is deliberate: revoked beats accepted beats expired. Somebody who
 * revoked an invite wants to be told it was revoked, not that it happens to
 * have aged out as well.
 */
export function inviteState(row: InviteRow, now: Date = new Date()): InviteState {
  if (row.revokedAt) return "revoked";
  if (row.acceptedAt) return "accepted";
  if (row.expiresAt.getTime() <= now.getTime()) return "expired";
  return "usable";
}

/**
 * Can this user act under this org?
 *
 * A superadmin can act anywhere — that is what the flag means, and requiring
 * them to hold a membership row in every tenant would mean an org they had not
 * been added to is invisible to the one account meant to see everything.
 * Everyone else needs a membership.
 */
export function mayActAs(
  user: { isSuperadmin: boolean } | null,
  memberships: Array<{ orgId: number; role: string }>,
  orgId: number,
): { allowed: boolean; role: string | null } {
  if (!user) return { allowed: false, role: null };
  const m = memberships.find((x) => x.orgId === orgId);
  if (m) return { allowed: true, role: m.role };
  // A superadmin switching into an org they hold no membership in keeps admin
  // rights: they are administering the platform, not acting as a member of
  // that tenant.
  if (user.isSuperadmin) return { allowed: true, role: "admin" };
  return { allowed: false, role: null };
}
