import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../queries/connection", () => ({ getDb: () => ({}) }));
import { hasChildren, setTree, subtree, validateParent } from "./org-tree";
import { accessibleOrgIds, assertOrgWrite, orgWhere } from "./org-scope";
import type { User } from "@db/schema";

// 1 installer → 2, 3 customers; 3 → 4 (sub-customer); 5 standalone
beforeEach(() =>
  setTree([
    { id: 1, parentOrgId: null },
    { id: 2, parentOrgId: 1 },
    { id: 3, parentOrgId: 1 },
    { id: 4, parentOrgId: 3 },
    { id: 5, parentOrgId: null },
  ]),
);

const user = (orgId: number) => ({ id: 9, orgId, role: "operator", isSuperadmin: false }) as unknown as User;

describe("org tree", () => {
  it("computes subtrees", () => {
    expect(subtree(1).sort()).toEqual([1, 2, 3, 4]);
    expect(subtree(3).sort()).toEqual([3, 4]);
    expect(subtree(5)).toEqual([5]);
    expect(hasChildren(1)).toBe(true);
    expect(hasChildren(2)).toBe(false);
  });
  it("refuses self-parent, cycles, unknown parents and deep trees", () => {
    expect(validateParent(2, 2)).toMatch(/own parent/);
    expect(validateParent(1, 4)).toMatch(/cycle/);
    expect(validateParent(5, 99)).toMatch(/not found/);
    expect(validateParent(5, 4)).toBeNull(); // 1 → 3 → 4 → 5 = 4 levels, allowed
    setTree([
      { id: 1, parentOrgId: null },
      { id: 3, parentOrgId: 1 },
      { id: 4, parentOrgId: 3 },
      { id: 5, parentOrgId: null },
      { id: 6, parentOrgId: 5 },
    ]);
    expect(validateParent(5, 4)).toMatch(/levels/);
    expect(validateParent(6, 1)).toBeNull();
    expect(validateParent(2, null)).toBeNull();
  });
});

describe("org-scope with hierarchy", () => {
  it("an installer user reaches its customers, a customer only itself", () => {
    expect(accessibleOrgIds(user(1)).sort()).toEqual([1, 2, 3, 4]);
    expect(accessibleOrgIds(user(2))).toEqual([2]);
    expect(() => assertOrgWrite(user(1), 4, "Device")).not.toThrow();
    expect(() => assertOrgWrite(user(2), 3, "Device")).toThrow(/another organization/);
    expect(() => assertOrgWrite(user(3), 1, "Device")).toThrow(/another organization/);
  });
  it("orgWhere returns a filter for normal users", () => {
    expect(orgWhere(user(1), {} as never)).toBeDefined();
  });
});
