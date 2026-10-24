import { describe, expect, it } from "vitest";
import { aggregateSite, availability, bucketsBetween, dataCompleteness, performanceRatio } from "./technical";

const b = (i: number, samples: number, values: Record<string, number | null> = {}) => ({ bucketStartSec: i * 900, samples, values });

describe("technical KPIs", () => {
  it("counts whole 15-min buckets in a range", () => {
    expect(bucketsBetween(0, 3_600_000)).toBe(4);
    expect(bucketsBetween(60_000, 3_600_000)).toBe(3);
  });
  it("availability = buckets with data / expected", () => {
    expect(availability([b(0, 5), b(1, 1), b(3, 2)], 4)).toBe(0.75);
    expect(availability([], 0)).toBeNull();
  });
  it("completeness caps per bucket at the poll-interval expectation", () => {
    // 60 s poll → 15 per bucket; 2 buckets expected
    expect(dataCompleteness([b(0, 15), b(1, 30)], 2, 60)).toBe(1);
    expect(dataCompleteness([b(0, 15)], 2, 60)).toBe(0.5);
    expect(dataCompleteness([b(0, 1)], 1, 3600)).toBe(1);
  });
  it("performance ratio uses only intervals with power AND irradiance", () => {
    // 10 kWp, 4 intervals of 1000 W/m², 8 kW → PR 0.8; a 5th interval without irradiance ignored
    const power = [0, 1, 2, 3, 4].map((i) => b(i, 1, { activePowerKw: 8 }));
    const irr = [0, 1, 2, 3].map((i) => b(i, 1, { irradianceWm2: 1000 }));
    const r = performanceRatio(power, irr, 10);
    expect(r.performanceRatio).toBeCloseTo(0.8);
    expect(r.intervals).toBe(4);
    expect(r.energyKwh).toBeCloseTo(8);
    expect(performanceRatio(power, irr, null).performanceRatio).toBeNull();
    expect(performanceRatio(power, [], 10).performanceRatio).toBeNull();
  });
  it("aggregates a site energy-weighted", () => {
    const d = (id: number, pr: number, e: number, h: number, a: number) => ({ meterId: id, from: "", to: "", availability: a, dataCompleteness: a, performanceRatio: pr, energyKwh: e, irradiationKwhM2: h });
    const agg = aggregateSite([d(1, 0.8, 8, 1, 1), d(2, 0.6, 12, 2, 0.5)], new Map([[1, 10], [2, 10]]));
    expect(agg.performanceRatio).toBeCloseTo(20 / 30);
    expect(agg.availability).toBe(0.75);
  });
});
