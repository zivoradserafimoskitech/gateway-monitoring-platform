// Wave 5 / T1: profiles.updateVerification is ADMIN-ONLY — the
// allowUnverifiedControl flag bypasses the draft-profile control gate, so an
// operator or viewer must not be able to flip it. Also pins the allowed
// status transitions (field_verified manual set records verifiedBy/verifiedAt;
// revert to draft clears them; bench_verified is NOT settable here — it is
// earned via the Task-3 bench workflow). DB and profile cache are mocked.
import { beforeEach, test, vi } from "vitest";
import assert from "node:assert/strict";
import { TRPCError } from "@trpc/server";

const state = vi.hoisted(() => ({
  db: null as unknown,
  profiles: [] as Array<Record<string, unknown>>,
  updates: [] as Array<Record<string, unknown>>,
  auditInserts: 0,
}));

vi.mock("../queries/connection", () => ({ getDb: () => state.db }));
vi.mock("../mqtt/handlers", () => ({ invalidateProfileCache: () => undefined }));

import { profilesRouter } from "./profiles";

/** Fake drizzle client covering the profiles router + RBAC audit trail. */
function fakeDb(): void {
  const makeQuery = (rows: unknown[]): unknown => {
    const q = {
      where: () => q,
      orderBy: () => q,
      limit: () => q,
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) => Promise.resolve(rows).then(onF, onR),
    };
    return q;
  };
  state.db = {
    select: () => ({ from: () => makeQuery(state.profiles) }),
    update: () => ({
      set: (v: Record<string, unknown>) => {
        state.updates.push(v);
        return { where: () => Promise.resolve([{ affectedRows: 1 }]) };
      },
    }),
    // RBAC middleware fire-and-forget audit insert (denied + succeeded).
    insert: () => ({
      values: () => {
        state.auditInserts += 1;
        return { catch: () => undefined };
      },
    }),
  };
}

const PROFILE = {
  id: 1,
  model: "BESS-A",
  label: "Test BESS",
  verificationStatus: "draft",
  allowUnverifiedControl: false,
  verifiedBy: null,
  verifiedAt: null,
};

function caller(role: "admin" | "operator" | "viewer" | null) {
  const ctx = {
    req: new Request("http://localhost/api/trpc"),
    resHeaders: new Headers(),
    sessionToken: null,
    user:
      role === null
        ? null
        : ({ id: 9, email: `${role}@example.test`, role, orgId: 1, isSuperadmin: false } as never),
  };
  return profilesRouter.createCaller(ctx);
}

beforeEach(() => {
  process.env.AUTH_REQUIRED = "true"; // RBAC enforced (not the open demo mode)
  state.profiles = [{ ...PROFILE }];
  state.updates = [];
  state.auditInserts = 0;
  fakeDb();
});

test("updateVerification: operator is FORBIDDEN from setting allowUnverifiedControl", async () => {
  await assert.rejects(
    caller("operator").updateVerification({ id: 1, allowUnverifiedControl: true }),
    (e: Error) => e instanceof TRPCError && e.code === "FORBIDDEN",
  );
  assert.equal(state.updates.length, 0); // nothing was written
});

test("updateVerification: viewer is FORBIDDEN; anonymous is UNAUTHORIZED", async () => {
  await assert.rejects(
    caller("viewer").updateVerification({ id: 1, allowUnverifiedControl: true }),
    (e: Error) => e instanceof TRPCError && e.code === "FORBIDDEN",
  );
  await assert.rejects(
    caller(null).updateVerification({ id: 1, allowUnverifiedControl: true }),
    (e: Error) => e instanceof TRPCError && e.code === "UNAUTHORIZED",
  );
  assert.equal(state.updates.length, 0);
});

test("updateVerification: admin can set and clear the commissioning override", async () => {
  await caller("admin").updateVerification({ id: 1, allowUnverifiedControl: true });
  assert.deepEqual(state.updates[0], { allowUnverifiedControl: true });
  await caller("admin").updateVerification({ id: 1, allowUnverifiedControl: false });
  assert.deepEqual(state.updates[1], { allowUnverifiedControl: false });
});

test("updateVerification: admin set to field_verified records verifiedBy (current user) and verifiedAt", async () => {
  await caller("admin").updateVerification({ id: 1, verificationStatus: "field_verified" });
  const patch = state.updates[0];
  assert.equal(patch.verificationStatus, "field_verified");
  assert.equal(patch.verifiedBy, 9); // the calling admin's user id
  assert.ok(patch.verifiedAt instanceof Date);
});

test("updateVerification: admin revert to draft clears verifiedBy/verifiedAt", async () => {
  await caller("admin").updateVerification({ id: 1, verificationStatus: "draft" });
  const patch = state.updates[0];
  assert.equal(patch.verificationStatus, "draft");
  assert.equal(patch.verifiedBy, null);
  assert.equal(patch.verifiedAt, null);
});

test("updateVerification: bench_verified is NOT settable through this endpoint (Task-3 workflow only)", async () => {
  await assert.rejects(
    caller("admin").updateVerification({ id: 1, verificationStatus: "bench_verified" as never }),
    (e: Error) => !(e instanceof TRPCError) || e.code === "BAD_REQUEST",
  );
  assert.equal(state.updates.length, 0);
});

test("updateVerification: unknown profile id → NOT_FOUND", async () => {
  state.profiles = [];
  await assert.rejects(
    caller("admin").updateVerification({ id: 999, allowUnverifiedControl: true }),
    (e: Error) => e instanceof TRPCError && e.code === "NOT_FOUND",
  );
});
