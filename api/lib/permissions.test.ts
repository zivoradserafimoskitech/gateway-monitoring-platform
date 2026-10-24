import { describe, expect, it } from "vitest";
import { can, validateExtra } from "./permissions";

const op = { role: "operator" as const, isSuperadmin: false };

describe("per-site permissions", () => {
  it("without site grants the org role decides", () => {
    expect(can(op, 1, "device.control", [])).toBe(true);
    expect(can({ role: "viewer", isSuperadmin: false }, 1, "device.control", [])).toBe(false);
    expect(can(op, 1, "commissioning.signoff", [])).toBe(false);
  });
  it("site grants confine the user to their sites", () => {
    const grants = [{ siteId: 7, role: "field_tech" as const }];
    expect(can(op, 7, "commissioning.perform", grants)).toBe(true);
    expect(can(op, 7, "device.control", grants)).toBe(false);
    expect(can(op, 8, "site.view", grants)).toBe(false);
    expect(can(op, null, "site.view", grants)).toBe(false);
  });
  it("extra permissions add to a role; superadmin always passes", () => {
    expect(can(op, 7, "device.control", [{ siteId: 7, role: "field_tech", extra: ["device.control"] }])).toBe(true);
    expect(can({ role: "viewer", isSuperadmin: true }, 1, "ota.deploy", [{ siteId: 2, role: "site_viewer" }])).toBe(true);
  });
  it("validates extra", () => {
    expect(validateExtra(["alarm.ack"])).toEqual(["alarm.ack"]);
    expect(validateExtra(["root"])).toMatch(/unknown/);
    expect(validateExtra(null)).toEqual([]);
  });
});
