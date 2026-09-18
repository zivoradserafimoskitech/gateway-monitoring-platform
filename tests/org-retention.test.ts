// §9.14: per-org retention. The arithmetic runs the opposite way from how it
// reads — MORE days means an EARLIER cutoff — so the case that matters is
// whether a tenant paying to keep five years survives a sweep written around
// a ninety-day default.
import { describe, it, expect } from "vitest";
import { defaultNeedsOwnPass, retentionPlan } from "../api/orgs/retention";
import { deletionDueAt } from "../api/orgs/purge";

const NOW = new Date("2026-06-01T00:00:00.000Z");
const daysBefore = (n: number) => new Date(NOW.getTime() - n * 86_400_000).toISOString();

describe("retentionPlan", () => {
  it("with no overrides, the global sweep IS the default", () => {
    const plan = retentionPlan(NOW, 90, []);
    expect(plan.globalCutoff.toISOString()).toBe(daysBefore(90));
    expect(plan.perOrg).toEqual([]);
    expect(defaultNeedsOwnPass(plan, NOW, 90)).toBe(false);
  });

  it("a tenant keeping LONGER pushes the global sweep back, not forward", () => {
    // The failure this prevents: a global purge at 90 days deleting the rows a
    // tenant is paying to keep for five years.
    const plan = retentionPlan(NOW, 90, [{ orgId: 7, days: 1825 }]);
    expect(plan.globalCutoff.toISOString()).toBe(daysBefore(1825));
    // Everyone on the default now needs a targeted pass of their own.
    expect(defaultNeedsOwnPass(plan, NOW, 90)).toBe(true);
    // The long-retention org is not in perOrg: the global sweep is already its
    // horizon, and a second delete at the same cutoff would do nothing.
    expect(plan.perOrg).toEqual([]);
  });

  it("a tenant keeping LESS gets its own, later cutoff", () => {
    const plan = retentionPlan(NOW, 90, [{ orgId: 3, days: 30 }]);
    expect(plan.globalCutoff.toISOString()).toBe(daysBefore(90));
    expect(plan.perOrg).toHaveLength(1);
    expect(plan.perOrg[0].orgId).toBe(3);
    expect(plan.perOrg[0].cutoff.toISOString()).toBe(daysBefore(30));
    expect(defaultNeedsOwnPass(plan, NOW, 90)).toBe(false);
  });

  it("handles both directions at once", () => {
    const plan = retentionPlan(NOW, 90, [
      { orgId: 1, days: 365 },
      { orgId: 2, days: 30 },
      { orgId: 3, days: 7 },
    ]);
    expect(plan.globalCutoff.toISOString()).toBe(daysBefore(365));
    expect(plan.perOrg.map((p) => p.orgId).sort()).toEqual([2, 3]);
    expect(defaultNeedsOwnPass(plan, NOW, 90)).toBe(true);
  });

  it("rolls up to the LATEST cutoff, so a short retention loses no aggregates", () => {
    // Rows about to be deleted must be in an aggregate first, or a tenant with
    // a 7-day retention gets blank reports instead of coarse ones.
    const plan = retentionPlan(NOW, 90, [
      { orgId: 1, days: 365 },
      { orgId: 3, days: 7 },
    ]);
    expect(plan.rollupUpTo.toISOString()).toBe(daysBefore(7));
  });

  it("rolls up to the default when that is the shortest horizon", () => {
    const plan = retentionPlan(NOW, 90, [{ orgId: 1, days: 365 }]);
    expect(plan.rollupUpTo.toISOString()).toBe(daysBefore(90));
  });

  it("ignores an override that equals the default", () => {
    // Otherwise it would add a targeted delete that can never match a row.
    const plan = retentionPlan(NOW, 90, [{ orgId: 5, days: 90 }]);
    expect(plan.perOrg).toEqual([]);
    expect(plan.globalCutoff.toISOString()).toBe(daysBefore(90));
  });

  it("falls back to the default for a nonsensical override", () => {
    for (const bad of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const plan = retentionPlan(NOW, 90, [{ orgId: 9, days: bad }]);
      expect(plan.globalCutoff.toISOString()).toBe(daysBefore(90));
      expect(plan.perOrg).toEqual([]);
    }
  });
});

describe("deletionDueAt", () => {
  it("defaults to a week out", () => {
    expect(deletionDueAt(NOW, 7).toISOString()).toBe(new Date(NOW.getTime() + 7 * 86_400_000).toISOString());
  });

  it("refuses a zero or negative grace period", () => {
    // A zero-day grace period is an immediate delete wearing the word
    // "scheduled", and this operation has nothing to inspect afterwards.
    for (const bad of [0, -1, Number.NaN]) {
      expect(deletionDueAt(NOW, bad).toISOString()).toBe(new Date(NOW.getTime() + 7 * 86_400_000).toISOString());
    }
  });
});
