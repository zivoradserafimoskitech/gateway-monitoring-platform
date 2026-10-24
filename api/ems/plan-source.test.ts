import { describe, expect, it } from "vitest";
import { choosePlan, externalPlanMaxAgeMs, isFreshExternal, localOptimizerMode, LOCAL_PLAN_SOURCE } from "./plan-source";

const now = Date.parse("2026-10-24T12:00:00Z");
const H = 3_600_000;

describe("plan arbitration (external plan > local fallback)", () => {
  it("prefers a fresh external plan even when the local plan is newer", () => {
    const plans = [
      { id: 2, source: LOCAL_PLAN_SOURCE, createdAt: new Date(now - 60_000) },
      { id: 1, source: "volttrade", createdAt: new Date(now - H) },
    ];
    expect(choosePlan(plans, now, 24 * H)?.id).toBe(1);
  });
  it("falls back to the local plan when the external plan is stale", () => {
    const plans = [
      { id: 2, source: LOCAL_PLAN_SOURCE, createdAt: new Date(now - 60_000) },
      { id: 1, source: "volttrade", createdAt: new Date(now - 30 * H) },
    ];
    expect(choosePlan(plans, now, 24 * H)?.id).toBe(2);
  });
  it("uses a stale external plan when there is no local plan", () => {
    expect(choosePlan([{ id: 1, source: "volttrade", createdAt: new Date(now - 30 * H) }], now, 24 * H)?.id).toBe(1);
  });
  it("returns null for no plans", () => {
    expect(choosePlan([], now, H)).toBeNull();
  });
  it("max age 0 disables the staleness check", () => {
    expect(isFreshExternal({ id: 1, source: "x", createdAt: new Date(0) }, now, 0)).toBe(true);
    expect(isFreshExternal({ id: 1, source: LOCAL_PLAN_SOURCE }, now, 0)).toBe(false);
  });
  it("reads config from env", () => {
    expect(externalPlanMaxAgeMs({})).toBe(24 * H);
    expect(externalPlanMaxAgeMs({ EMS_EXTERNAL_PLAN_MAX_AGE_MIN: "30" })).toBe(30 * 60_000);
    expect(externalPlanMaxAgeMs({ EMS_EXTERNAL_PLAN_MAX_AGE_MIN: "bogus" })).toBe(24 * H);
    expect(localOptimizerMode({})).toBe("fallback");
    expect(localOptimizerMode({ EMS_LOCAL_OPTIMIZER: "off" })).toBe("off");
  });
});
