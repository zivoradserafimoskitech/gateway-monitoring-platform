import { describe, expect, it } from "vitest";
import { compositeBreached, describeComposite, ratePerMinute, rocBreached, thresholdBreached, validateComposite } from "./conditions";

describe("deadband", () => {
  it("gt: raises above threshold, clears only below threshold - deadband", () => {
    expect(thresholdBreached("gt", 101, 100, false, 5)).toBe(true);
    expect(thresholdBreached("gt", 98, 100, true, 5)).toBe(true);
    expect(thresholdBreached("gt", 94, 100, true, 5)).toBe(false);
    expect(thresholdBreached("gt", 98, 100, false, 5)).toBe(false);
  });
  it("lt mirrors it; no deadband behaves as before", () => {
    expect(thresholdBreached("lt", 12, 10, true, 3)).toBe(true);
    expect(thresholdBreached("lt", 14, 10, true, 3)).toBe(false);
    expect(thresholdBreached("lt", 10.5, 10, true, null)).toBe(false);
  });
});

describe("rate of change", () => {
  it("computes units per minute", () => {
    expect(ratePerMinute({ value: 20, at: 0 }, 23, 60_000)).toBe(3);
    expect(ratePerMinute(undefined, 1, 1)).toBeNull();
    expect(ratePerMinute({ value: 1, at: 1000 }, 2, 1500)).toBeNull();
  });
  it("breaches on absolute rate and keeps state without data", () => {
    expect(rocBreached(-6, 5, false, 0)).toBe(true);
    expect(rocBreached(null, 5, true, 0)).toBe(true);
    expect(rocBreached(4, 5, true, 2)).toBe(true);
    expect(rocBreached(2, 5, true, 2)).toBe(false);
  });
});

describe("composite", () => {
  const spec = { op: "and" as const, terms: [{ metric: "socPercent", operator: "lt" as const, threshold: 10 }, { metric: "gridKw", operator: "gt" as const, threshold: 50 }] };
  it("AND needs every term", () => {
    expect(compositeBreached(spec, { socPercent: 5, gridKw: 60 }, false, 0)).toBe(true);
    expect(compositeBreached(spec, { socPercent: 5, gridKw: 40 }, false, 0)).toBe(false);
    expect(compositeBreached(spec, { socPercent: 5 }, false, 0)).toBeNull();
    expect(compositeBreached(spec, { socPercent: 50 }, false, 0)).toBe(false);
  });
  it("OR needs any term", () => {
    const or = { ...spec, op: "or" as const };
    expect(compositeBreached(or, { gridKw: 60 }, false, 0)).toBe(true);
    expect(compositeBreached(or, { socPercent: 50 }, false, 0)).toBeNull();
    expect(compositeBreached(or, { socPercent: 50, gridKw: 10 }, false, 0)).toBe(false);
  });
  it("validates and describes", () => {
    expect(validateComposite(spec)).toEqual(spec);
    expect(validateComposite({ op: "xor", terms: [] })).toMatch(/op/);
    expect(validateComposite({ op: "and", terms: [spec.terms[0]] })).toMatch(/2\.\./);
    expect(describeComposite(spec)).toBe("socPercent < 10 AND gridKw > 50");
  });
});
