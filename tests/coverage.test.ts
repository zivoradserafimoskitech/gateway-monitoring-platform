// §9.7: data completeness derived from the report itself.
import { describe, it, expect } from "vitest";
import { median, withCoverage } from "../api/reports/coverage";
import type { DailyReportRow } from "../api/telemetry/types";

const day = (d: string, samples: number): DailyReportRow => ({
  day: d,
  importKwh: 1,
  exportKwh: 0,
  maxDemandKw: null,
  demandDerived: false,
  counterReset: false,
  avgPowerFactor: null,
  samples,
});

describe("median", () => {
  it("handles odd and even counts", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
  it("is null for nothing", () => {
    expect(median([])).toBeNull();
  });
});

describe("withCoverage", () => {
  it("flags the day the gateway spent mostly offline", () => {
    const out = withCoverage([
      day("2025-01-01", 2880),
      day("2025-01-02", 2880),
      day("2025-01-03", 96),
      day("2025-01-04", 2880),
    ]);
    expect(out[2].coverage).toBeCloseTo(0.03, 2);
    expect(out[0].coverage).toBe(1);
  });

  it("caps a day that reported more often than usual at 1", () => {
    // A device that was polled twice as fast for a day is not "200% complete".
    const out = withCoverage([day("a", 100), day("b", 100), day("c", 100), day("d", 400)]);
    expect(out[3].coverage).toBe(1);
  });

  it("does not let empty days drag the baseline to zero", () => {
    // Excluding them is what keeps the surviving days honest: with zeros in
    // the median, a day at 10% of normal would read as complete.
    const out = withCoverage([day("a", 0), day("b", 0), day("c", 0), day("d", 100), day("e", 100), day("f", 10)]);
    expect(out[3].coverage).toBe(1);
    expect(out[5].coverage).toBeCloseTo(0.1, 2);
    expect(out[0].coverage).toBe(0);
  });

  it("says nothing rather than guessing on a report too short to calibrate", () => {
    // With two days, one bad day IS the median, and every coverage number
    // derived from it would be a fabrication.
    for (const rows of [[day("a", 100)], [day("a", 100), day("b", 5)]]) {
      expect(withCoverage(rows).every((d) => d.coverage === null)).toBe(true);
    }
  });
});
