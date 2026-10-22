// §9.14 × §9.11: deleting an org must not delete an account another org still
// has as a member, nor a platform administrator who happened to live there.
import { describe, it, expect } from "vitest";
import { planUserRemoval, type PurgeMembership, type PurgeUser } from "../api/orgs/purge-users";

const ORG = 7;
const user = (id: number, orgId: number | null, isSuperadmin = false): PurgeUser => ({
  id,
  orgId,
  role: "operator",
  isSuperadmin,
});
const member = (userId: number, orgId: number, role = "viewer"): PurgeMembership => ({ userId, orgId, role });

describe("planUserRemoval", () => {
  it("removes an account that belongs only to the deleted org", () => {
    const out = planUserRemoval(ORG, [user(1, ORG)], [member(1, ORG)]);
    expect(out).toEqual({ remove: [1], move: [], detach: [] });
  });

  it("keeps an account another org still has, and moves it there", () => {
    // Active in the org being deleted, a viewer in org 9: the account stays,
    // now active in 9 with the role it holds there.
    const out = planUserRemoval(ORG, [user(1, ORG)], [member(1, ORG, "admin"), member(1, 9, "viewer")]);
    expect(out).toEqual({ remove: [], move: [{ userId: 1, orgId: 9, role: "viewer" }], detach: [] });
  });

  it("moves to the lowest org id when several remain, whatever the row order", () => {
    const ms = [member(1, ORG), member(1, 12), member(1, 9)];
    expect(planUserRemoval(ORG, [user(1, ORG)], ms).move[0].orgId).toBe(9);
    expect(planUserRemoval(ORG, [user(1, ORG)], [...ms].reverse()).move[0].orgId).toBe(9);
  });

  it("leaves alone an account that is merely a member here and active elsewhere", () => {
    const out = planUserRemoval(ORG, [user(1, 9)], [member(1, ORG), member(1, 9)]);
    expect(out).toEqual({ remove: [], move: [], detach: [] });
  });

  it("counts a home org with no membership row as belonging somewhere", () => {
    // Every account looked like this before §9.11.
    const out = planUserRemoval(ORG, [user(1, 9)], [member(1, ORG)]);
    expect(out.remove).toEqual([]);
  });

  it("removes an account with no home org whose only membership was here", () => {
    const out = planUserRemoval(ORG, [user(1, null)], [member(1, ORG)]);
    expect(out.remove).toEqual([1]);
  });

  it("never removes a platform administrator", () => {
    expect(planUserRemoval(ORG, [user(1, ORG, true)], [])).toEqual({ remove: [], move: [], detach: [1] });
    expect(planUserRemoval(ORG, [user(1, ORG, true)], [member(1, 9, "admin")])).toEqual({
      remove: [],
      move: [{ userId: 1, orgId: 9, role: "admin" }],
      detach: [],
    });
    expect(planUserRemoval(ORG, [user(1, 9, true)], [member(1, ORG)])).toEqual({ remove: [], move: [], detach: [] });
  });
});
