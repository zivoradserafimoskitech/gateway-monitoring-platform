import { describe, expect, it } from "vitest";
import { matchTags, normalizeTags, resolveSelection } from "./select";

const gws = [
  { id: 1, tags: ["north", "bess"] },
  { id: 2, tags: ["north"] },
  { id: 3, tags: null },
];

describe("fleet selection", () => {
  it("normalizes tags", () => {
    expect(normalizeTags([" North ", "north", "bess"])).toEqual(["bess", "north"]);
    expect(() => normalizeTags(["bad tag"])).toThrow();
  });
  it("matches all tags", () => {
    expect(matchTags(gws, ["north"])).toEqual([1, 2]);
    expect(matchTags(gws, ["north", "bess"])).toEqual([1]);
  });
  it("intersects selectors and drops invisible ids", () => {
    expect(resolveSelection(gws, { gatewayIds: [1, 2, 99] })).toEqual([1, 2]);
    expect(resolveSelection(gws, { groupMemberIds: [2, 3], tags: ["north"] })).toEqual([2]);
    expect(resolveSelection(gws, {})).toEqual([1, 2, 3]);
    expect(resolveSelection(gws, { groupMemberIds: [] })).toEqual([]);
  });
});
