// Merge arithmetic for report ranges that straddle the raw-retention cutoff
// (api/telemetry/merge.ts). Both stores split such a range into a raw part and
// an aggregated part, so these rules decide what a report says about the day
// the cutoff falls on — worth pinning without a database in the loop.
import { describe, it, expect } from "vitest";
import { mergeDayRows, mergeEnergyBuckets, mergeHistoryPoints } from "../api/telemetry/merge";
import type { DailyReportRow, EnergyIntervalBucket, HistoryPoint } from "../api/telemetry/types";

const day = (over: Partial<DailyReportRow>): DailyReportRow => ({
  day: "2025-01-15",
  importKwh: 0,
  exportKwh: 0,
  maxDemandKw: null,
  demandDerived: false,
  counterReset: false,
  avgPowerFactor: null,
  samples: 0,
  ...over,
});

const bucket = (over: Partial<EnergyIntervalBucket>): EnergyIntervalBucket => ({
  bucketStartSec: 0,
  importKwh: 0,
  exportKwh: 0,
  avgPowerKw: null,
  samples: 0,
  estimated: false,
  ...over,
});

describe("mergeDayRows", () => {
  it("sums energies and samples for the same day", () => {
    const out = mergeDayRows([
      [day({ importKwh: 10, exportKwh: 1, samples: 30 })],
      [day({ importKwh: 5.5, exportKwh: 0.5, samples: 20 })],
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].importKwh).toBe(15.5);
    expect(out[0].exportKwh).toBe(1.5);
    expect(out[0].samples).toBe(50);
  });

  it("weights power factor by sample count, not by part", () => {
    // A 1-sample raw tail must not drag a 3600-sample aggregated day.
    const out = mergeDayRows([
      [day({ avgPowerFactor: 1.0, samples: 1 })],
      [day({ avgPowerFactor: 0.9, samples: 99 })],
    ]);
    expect(out[0].avgPowerFactor).toBe(0.901);
  });

  it("takes the maximum demand and keeps a reset flag sticky", () => {
    const out = mergeDayRows([
      [day({ maxDemandKw: 12, counterReset: true, samples: 1 })],
      [day({ maxDemandKw: 30, counterReset: false, samples: 1 })],
    ]);
    expect(out[0].maxDemandKw).toBe(30);
    expect(out[0].counterReset).toBe(true);
  });

  it("keeps demandDerived only when BOTH parts derived it", () => {
    // One part with real demand samples means the day's maximum is measured.
    const mixed = mergeDayRows([
      [day({ demandDerived: true, samples: 1 })],
      [day({ demandDerived: false, samples: 1 })],
    ]);
    expect(mixed[0].demandDerived).toBe(false);
    const both = mergeDayRows([
      [day({ demandDerived: true, samples: 1 })],
      [day({ demandDerived: true, samples: 1 })],
    ]);
    expect(both[0].demandDerived).toBe(true);
  });

  it("treats null as absent rather than as zero", () => {
    const out = mergeDayRows([
      [day({ importKwh: null, avgPowerFactor: null, maxDemandKw: null, samples: 0 })],
      [day({ importKwh: 4, avgPowerFactor: 0.8, maxDemandKw: 7, samples: 10 })],
    ]);
    expect(out[0].importKwh).toBe(4);
    expect(out[0].avgPowerFactor).toBe(0.8);
    expect(out[0].maxDemandKw).toBe(7);
  });

  it("keeps distinct days apart and returns them in order", () => {
    const out = mergeDayRows([
      [day({ day: "2025-01-16", importKwh: 2, samples: 1 })],
      [day({ day: "2025-01-15", importKwh: 1, samples: 1 })],
    ]);
    expect(out.map((r) => r.day)).toEqual(["2025-01-15", "2025-01-16"]);
  });

  it("does not mutate the input rows", () => {
    const a = day({ importKwh: 1, samples: 1 });
    mergeDayRows([[a], [day({ importKwh: 2, samples: 1 })]]);
    expect(a.importKwh).toBe(1);
    expect(a.samples).toBe(1);
  });
});

describe("mergeEnergyBuckets", () => {
  it("merges a bucket that straddles the cutoff and keeps the rest", () => {
    const out = mergeEnergyBuckets([
      [bucket({ bucketStartSec: 900, importKwh: 0.5, samples: 2, estimated: true })],
      [
        bucket({ bucketStartSec: 900, importKwh: 0.25, samples: 2 }),
        bucket({ bucketStartSec: 1800, importKwh: 1, samples: 4 }),
      ],
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ bucketStartSec: 900, importKwh: 0.75, samples: 4, estimated: true });
    expect(out[1].bucketStartSec).toBe(1800);
  });

  it("weights average power by sample count", () => {
    const out = mergeEnergyBuckets([
      [bucket({ avgPowerKw: 10, samples: 3 })],
      [bucket({ avgPowerKw: 2, samples: 1 })],
    ]);
    expect(out[0].avgPowerKw).toBe(8);
  });
});

describe("mergeHistoryPoints", () => {
  const pt = (over: Partial<HistoryPoint>): HistoryPoint => ({
    ts: new Date("2025-01-15T00:00:00Z"),
    powerKw: null,
    activePowerKw: null,
    voltageL1: null,
    currentL1: null,
    powerFactor: null,
    frequencyHz: null,
    energyImportKwh: null,
    samples: 0,
    ...over,
  });

  it("weights a bucket that straddles the cutoff by sample count", () => {
    const out = mergeHistoryPoints([
      [pt({ activePowerKw: 10, samples: 9 })],
      [pt({ activePowerKw: 20, samples: 1 })],
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].activePowerKw).toBe(11);
    expect(out[0].samples).toBe(10);
  });

  it("takes the later energy counter rather than summing it", () => {
    // Counters are cumulative: adding the two halves of a bucket would report
    // roughly twice the meter's lifetime reading.
    const out = mergeHistoryPoints([
      [pt({ energyImportKwh: 100, samples: 1 })],
      [pt({ energyImportKwh: 140, samples: 1 })],
    ]);
    expect(out[0].energyImportKwh).toBe(140);
  });

  it("keeps separate buckets apart and orders them by time", () => {
    const later = new Date("2025-01-15T01:00:00Z");
    const out = mergeHistoryPoints([
      [pt({ ts: later, samples: 1 })],
      [pt({ samples: 1 })],
    ]);
    expect(out.map((p) => p.ts.toISOString())).toEqual([
      "2025-01-15T00:00:00.000Z",
      "2025-01-15T01:00:00.000Z",
    ]);
  });
});
