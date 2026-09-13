// §1.4: precedence of the three ways a self-announcing device gets a tenant.
import { describe, it, expect } from "vitest";
import {
  parseDefaultOrgId,
  resolveProvisionTarget,
} from "../api/mqtt/provision-org";

describe("parseDefaultOrgId", () => {
  it("accepts a positive integer", () => {
    expect(parseDefaultOrgId("3")).toBe(3);
  });

  it("ignores anything that is not one", () => {
    // A misconfigured value must not silently become org 0 or NaN and stamp
    // every device in the fleet with a tenant that does not exist.
    for (const bad of [undefined, "", "  ", "0", "-1", "1.5", "abc", "1abc"]) {
      expect(parseDefaultOrgId(bad), `expected ${JSON.stringify(bad)} to be ignored`).toBeNull();
    }
  });
});

describe("resolveProvisionTarget", () => {
  it("prefers a pre-registration over the default org", () => {
    const t = resolveProvisionTarget({ orgId: 7, siteId: 42 }, 3);
    expect(t).toEqual({ orgId: 7, siteId: 42, source: "registration" });
  });

  it("carries the registration's site, and tolerates one without", () => {
    expect(resolveProvisionTarget({ orgId: 7 }, null).siteId).toBeNull();
    expect(resolveProvisionTarget({ orgId: 7, siteId: null }, null).siteId).toBeNull();
  });

  it("falls back to the default org for a single-tenant installation", () => {
    expect(resolveProvisionTarget(null, 3)).toEqual({ orgId: 3, siteId: null, source: "default-org" });
  });

  it("leaves the device unclaimed when nothing decides", () => {
    // Unchanged behaviour, and still the right one: guessing a tenant is worse
    // than showing the device in the queue.
    expect(resolveProvisionTarget(null, null)).toEqual({ orgId: null, siteId: null, source: "unclaimed" });
  });
});
