// Unit tests for the multi-tenancy scoping helpers (v8/D2, v10/P1-9).
// Edge cases pinned here: superadmin/demo-mode bypass, the null-orgId → −1
// pattern (a sentinel that never matches a real row), stamping on create, and
// 404-vs-403 semantics (reads must not leak existence).
import { test } from "vitest";
import assert from "node:assert/strict";
import { TRPCError } from "@trpc/server";
import { MySqlDialect } from "drizzle-orm/mysql-core";
import { meters } from "@db/schema";
import type { User } from "@db/schema";
import {
  assertOrgRead,
  assertOrgWrite,
  assertRowOrg,
  assertRowOrgRead,
  isSuper,
  orgWhere,
  stampOrg,
} from "./org-scope";

const dialect = new MySqlDialect();

const user = (over: Partial<User>): User =>
  ({
    id: 1,
    orgId: 5,
    isSuperadmin: false,
    ...over,
  }) as User;

/** Render a drizzle WHERE fragment to SQL + params for assertions. */
function render(fragment: unknown): { sql: string; params: unknown[] } {
  const q = dialect.sqlToQuery(fragment as never);
  return { sql: q.sql, params: q.params };
}

// ─── isSuper ─────────────────────────────────────────────────────────────────
test("isSuper: null/undefined user = open demo mode → unrestricted", () => {
  assert.equal(isSuper(null), true);
  assert.equal(isSuper(undefined), true);
});

test("isSuper: boolean true and legacy tinyint 1 both qualify", () => {
  assert.equal(isSuper(user({ isSuperadmin: true })), true);
  assert.equal(isSuper(user({ isSuperadmin: 1 as unknown as boolean })), true);
});

test("isSuper: regular users (false / 0) are not super", () => {
  assert.equal(isSuper(user({ isSuperadmin: false })), false);
  assert.equal(isSuper(user({ isSuperadmin: 0 as unknown as boolean })), false);
});

// ─── orgWhere ────────────────────────────────────────────────────────────────
test("orgWhere: superadmin and demo mode get no filter (undefined)", () => {
  assert.equal(orgWhere(null, meters.orgId), undefined);
  assert.equal(orgWhere(user({ isSuperadmin: true }), meters.orgId), undefined);
});

test("orgWhere: regular user filters on their own org", () => {
  const { sql, params } = render(orgWhere(user({ orgId: 5 }), meters.orgId));
  assert.match(sql, /org_id/);
  assert.deepEqual(params, [5]);
});

test("orgWhere: null orgId falls back to the −1 sentinel (matches nothing)", () => {
  const { params } = render(orgWhere(user({ orgId: null }), meters.orgId));
  assert.deepEqual(params, [-1]);
});

// ─── stampOrg ────────────────────────────────────────────────────────────────
test("stampOrg: demo mode stamps the explicit value or null", () => {
  assert.equal(stampOrg(null, 7), 7);
  assert.equal(stampOrg(null), null);
  assert.equal(stampOrg(null, null), null);
});

test("stampOrg: superadmin may override explicitly, else stamps own org", () => {
  assert.equal(stampOrg(user({ isSuperadmin: true, orgId: 3 }), 9), 9);
  assert.equal(stampOrg(user({ isSuperadmin: true, orgId: 3 })), 3);
  assert.equal(stampOrg(user({ isSuperadmin: true, orgId: null })), null);
});

test("stampOrg: regular user always stamps their own org — explicit input is ignored", () => {
  assert.equal(stampOrg(user({ orgId: 5 }), 9), 5);
  assert.equal(stampOrg(user({ orgId: 5 })), 5);
  assert.equal(stampOrg(user({ orgId: null }), 9), null);
});

// ─── assertRowOrg (mutations on a fetched row) ───────────────────────────────
test("assertRowOrg: superadmin/demo mode may touch any org", () => {
  assert.doesNotThrow(() => assertRowOrg(null, 42));
  assert.doesNotThrow(() => assertRowOrg(user({ isSuperadmin: true }), 42));
});

test("assertRowOrg: matching org passes, foreign org → 403", () => {
  assert.doesNotThrow(() => assertRowOrg(user({ orgId: 5 }), 5));
  assert.throws(() => assertRowOrg(user({ orgId: 5 }), 6), (e: unknown) => e instanceof TRPCError && e.code === "FORBIDDEN");
});

test("assertRowOrg: user with null orgId can only touch rows stamped −1 (i.e. effectively nothing)", () => {
  // The −1 sentinel: null-org users match neither null-org rows nor real orgs.
  assert.throws(() => assertRowOrg(user({ orgId: null }), null), TRPCError);
  assert.throws(() => assertRowOrg(user({ orgId: null }), 5), TRPCError);
});

// ─── assertRowOrgRead (by-id reads) ──────────────────────────────────────────
test("assertRowOrgRead: missing row → 404", () => {
  assert.throws(() => assertRowOrgRead(user({ orgId: 5 }), null, "Device"), (e: unknown) => e instanceof TRPCError && e.code === "NOT_FOUND");
  assert.throws(() => assertRowOrgRead(user({ orgId: 5 }), undefined, "Device"), TRPCError);
});

test("assertRowOrgRead: foreign-org row → 404, not 403 (existence is not leaked)", () => {
  assert.throws(
    () => assertRowOrgRead(user({ orgId: 5 }), { orgId: 6 }, "Device"),
    (e: unknown) => e instanceof TRPCError && e.code === "NOT_FOUND",
  );
});

test("assertRowOrgRead: own row passes; superadmin sees everything", () => {
  assert.doesNotThrow(() => assertRowOrgRead(user({ orgId: 5 }), { orgId: 5 }, "Device"));
  assert.doesNotThrow(() => assertRowOrgRead(user({ isSuperadmin: true }), { orgId: 6 }, "Device"));
  assert.doesNotThrow(() => assertRowOrgRead(null, { orgId: 6 }, "Device"));
});

// ─── assertOrgRead / assertOrgWrite (by-id guards on a resolved org) ─────────
test("assertOrgRead: unknown row (undefined) → 404; foreign org → 404", () => {
  assert.throws(() => assertOrgRead(user({ orgId: 5 }), undefined, "Device"), (e: unknown) => e instanceof TRPCError && e.code === "NOT_FOUND");
  assert.throws(() => assertOrgRead(user({ orgId: 5 }), 6, "Device"), (e: unknown) => e instanceof TRPCError && e.code === "NOT_FOUND");
  assert.throws(() => assertOrgRead(user({ orgId: 5 }), null, "Device"), TRPCError); // null-org row vs org 5
});

test("assertOrgRead: own org passes; superadmin/demo bypass", () => {
  assert.doesNotThrow(() => assertOrgRead(user({ orgId: 5 }), 5, "Device"));
  assert.doesNotThrow(() => assertOrgRead(user({ isSuperadmin: true }), 6, "Device"));
  assert.doesNotThrow(() => assertOrgRead(null, 6, "Device"));
});

test("assertOrgWrite: unknown row → 404; foreign org → 403 (mutation may reveal existence)", () => {
  assert.throws(() => assertOrgWrite(user({ orgId: 5 }), undefined, "Device"), (e: unknown) => e instanceof TRPCError && e.code === "NOT_FOUND");
  assert.throws(() => assertOrgWrite(user({ orgId: 5 }), 6, "Device"), (e: unknown) => e instanceof TRPCError && e.code === "FORBIDDEN");
});

test("assertOrgWrite: own org passes; superadmin/demo bypass; null-orgId user writes nothing", () => {
  assert.doesNotThrow(() => assertOrgWrite(user({ orgId: 5 }), 5, "Device"));
  assert.doesNotThrow(() => assertOrgWrite(user({ isSuperadmin: true }), 6, "Device"));
  assert.doesNotThrow(() => assertOrgWrite(null, 6, "Device"));
  assert.throws(() => assertOrgWrite(user({ orgId: null }), 5, "Device"), (e: unknown) => e instanceof TRPCError && e.code === "FORBIDDEN");
});
