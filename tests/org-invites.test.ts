// §9.11: invite state and who may act under which org. Both decide whether
// somebody gets access, so both are driven directly rather than inferred from
// reading the router.
import { describe, it, expect } from "vitest";
import {
  inviteExpiryFrom,
  inviteState,
  inviteTokenHash,
  mayActAs,
  newInviteToken,
} from "../api/orgs/invites";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const later = (ms: number) => new Date(NOW.getTime() + ms);

describe("invite tokens", () => {
  it("are 256-bit and distinct", () => {
    const a = newInviteToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(newInviteToken());
  });

  it("hash stably, and the hash is not the token", () => {
    const token = newInviteToken();
    expect(inviteTokenHash(token)).toBe(inviteTokenHash(token));
    expect(inviteTokenHash(token)).not.toBe(token);
    expect(inviteTokenHash(token)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("inviteExpiryFrom", () => {
  it("defaults to a week", () => {
    expect(inviteExpiryFrom(NOW, 7).toISOString()).toBe(later(7 * 86_400_000).toISOString());
  });

  it("refuses a zero or nonsense TTL", () => {
    // A zero-day invite cannot be accepted by anybody.
    for (const bad of [0, -3, Number.NaN]) {
      expect(inviteExpiryFrom(NOW, bad).toISOString()).toBe(later(7 * 86_400_000).toISOString());
    }
  });

  it("caps at 90 days", () => {
    // An invite that effectively never expires is a credential with no owner
    // sitting in an inbox.
    expect(inviteExpiryFrom(NOW, 3650).toISOString()).toBe(later(90 * 86_400_000).toISOString());
  });
});

describe("inviteState", () => {
  const base = { expiresAt: later(86_400_000), acceptedAt: null, revokedAt: null };

  it("is usable before it expires", () => {
    expect(inviteState(base, NOW)).toBe("usable");
  });

  it("expires exactly at its deadline, not a moment after", () => {
    expect(inviteState({ ...base, expiresAt: NOW }, NOW)).toBe("expired");
  });

  it("reports revoked ahead of accepted and expired", () => {
    // Somebody who revoked an invite wants to be told it was revoked, not that
    // it also happens to have aged out.
    const row = { expiresAt: new Date(NOW.getTime() - 1), acceptedAt: NOW, revokedAt: NOW };
    expect(inviteState(row, NOW)).toBe("revoked");
  });

  it("reports accepted ahead of expired", () => {
    expect(inviteState({ expiresAt: new Date(NOW.getTime() - 1), acceptedAt: NOW, revokedAt: null }, NOW)).toBe(
      "accepted",
    );
  });
});

describe("mayActAs", () => {
  const member = { isSuperadmin: false };
  const superadmin = { isSuperadmin: true };
  const memberships = [
    { orgId: 1, role: "operator" },
    { orgId: 2, role: "viewer" },
  ];

  it("gives a member the role they hold in THAT org", () => {
    expect(mayActAs(member, memberships, 1)).toEqual({ allowed: true, role: "operator" });
    // The same person is deliberately allowed different rights per tenant —
    // the usual arrangement when a contractor looks after several customers.
    expect(mayActAs(member, memberships, 2)).toEqual({ allowed: true, role: "viewer" });
  });

  it("refuses an org the member does not belong to", () => {
    expect(mayActAs(member, memberships, 3)).toEqual({ allowed: false, role: null });
  });

  it("lets a superadmin act anywhere, as admin", () => {
    // Requiring a membership row in every tenant would make an org nobody
    // added them to invisible to the one account meant to see everything.
    expect(mayActAs(superadmin, [], 42)).toEqual({ allowed: true, role: "admin" });
  });

  it("prefers a superadmin's explicit membership over the implicit admin", () => {
    expect(mayActAs(superadmin, [{ orgId: 5, role: "viewer" }], 5)).toEqual({ allowed: true, role: "viewer" });
  });

  it("refuses when there is no user at all", () => {
    expect(mayActAs(null, memberships, 1)).toEqual({ allowed: false, role: null });
  });
});
