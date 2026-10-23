// §9.5: battery health. Every number here ends up in a warranty conversation,
// so the cases that matter are the ones where a naive implementation quietly
// reports a battery as healthier — or more worn — than it is.
import { describe, it, expect } from "vitest";
import {
  blendSoh,
  capacityFromWindow,
  cursorAfterSilence,
  efcDelta,
  samplesFromBuckets,
  sohPercent,
  sohReadRange,
  throughputDelta,
  windowStep,
  MIN_SOC_SPAN_PCT,
  SOH_BUCKET_MS,
  type SocSample,
} from "../api/ems/soh";

const T0 = new Date("2026-05-01T00:00:00Z");
const at = (min: number, soc: number | null, kw: number | null): SocSample => ({
  ts: new Date(T0.getTime() + min * 60_000),
  socPercent: soc,
  batteryPowerKw: kw,
});

describe("efcDelta", () => {
  it("counts a full charge plus a full discharge as one cycle", () => {
    expect(efcDelta(0, 100) + efcDelta(100, 0)).toBeCloseTo(1, 10);
  });

  it("counts shallow cycling, which a 'reached 100%' counter would score as nothing", () => {
    // Ten 20-point swings between 40% and 60% is two equivalent full cycles.
    let efc = 0;
    for (let i = 0; i < 10; i++) efc += efcDelta(40, 60) + efcDelta(60, 40);
    expect(efc).toBeCloseTo(2, 10);
  });

  it("is direction-blind", () => {
    expect(efcDelta(80, 30)).toBe(efcDelta(30, 80));
  });

  it("ignores a non-numeric reading rather than counting NaN cycles", () => {
    expect(efcDelta(Number.NaN, 50)).toBe(0);
    expect(efcDelta(50, Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("throughputDelta", () => {
  it("integrates a steady discharge", () => {
    // 10 kW for 12 minutes = 2 kWh out.
    const r = throughputDelta(at(0, 90, 10), at(12, 88, 10));
    expect(r.dischargedKwh).toBeCloseTo(2, 10);
    expect(r.chargedKwh).toBe(0);
  });

  it("integrates a charge into the other bucket", () => {
    // 20 kW for 12 minutes = 4 kWh in.
    const r = throughputDelta(at(0, 40, -20), at(12, 44, -20));
    expect(r.chargedKwh).toBeCloseTo(4, 10);
    expect(r.dischargedKwh).toBe(0);
  });

  it("uses the trapezoid, not the last reading, across a ramp", () => {
    // 0 → 10 kW over 6 minutes is 0.5 kWh, not the 1 kWh a step assumption
    // would book — and a battery following a peak-shaving setpoint is ramping
    // most of the time.
    expect(throughputDelta(at(0, 90, 0), at(6, 89, 10)).dischargedKwh).toBeCloseTo(0.5, 10);
  });

  it("splits an interval that crosses zero into both buckets", () => {
    // −10 kW → +10 kW over 12 minutes: 0.5 kWh each way. Averaging the two
    // readings would give zero and book nothing at all.
    const r = throughputDelta(at(0, 50, -10), at(12, 50, 10));
    expect(r.chargedKwh).toBeCloseTo(0.5, 10);
    expect(r.dischargedKwh).toBeCloseTo(0.5, 10);
  });

  it("books NOTHING across a long gap", () => {
    // Six hours offline must not become six hours of the last power reading —
    // that is how a battery acquires thousands of phantom kWh after an outage.
    expect(throughputDelta(at(0, 90, 50), at(360, 40, 50)).dischargedKwh).toBe(0);
  });

  it("books nothing when either sample has no power reading", () => {
    expect(throughputDelta(at(0, 90, null), at(5, 89, 10)).dischargedKwh).toBe(0);
    expect(throughputDelta(at(0, 90, 10), at(5, 89, null)).dischargedKwh).toBe(0);
  });

  it("books nothing for a non-finite reading, so the lifetime total stays a number", () => {
    // One NaN summed into the stored throughput would make the row unwritable
    // and leave the sweep re-reading the same page forever.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(throughputDelta(at(0, 50, bad), at(6, 49, 10))).toEqual({ dischargedKwh: 0, chargedKwh: 0 });
      expect(throughputDelta(at(0, 50, 10), at(6, 49, bad))).toEqual({ dischargedKwh: 0, chargedKwh: 0 });
    }
  });

  it("books nothing when a timestamp is not a time", () => {
    const broken: SocSample = { ts: new Date(Number.NaN), socPercent: 50, batteryPowerKw: 10 };
    expect(throughputDelta(broken, at(6, 49, 10))).toEqual({ dischargedKwh: 0, chargedKwh: 0 });
  });

  it("books nothing for a zero or negative interval", () => {
    expect(throughputDelta(at(5, 90, 10), at(5, 90, 10)).dischargedKwh).toBe(0);
    expect(throughputDelta(at(5, 90, 10), at(0, 91, 10)).dischargedKwh).toBe(0);
  });
});

describe("capacityFromWindow", () => {
  it("divides energy out by the fraction of the battery it emptied", () => {
    // 45 kWh taken from 90% to 40% implies 90 kWh usable.
    expect(capacityFromWindow({ socStart: 90, socEnd: 40, dischargedKwh: 45 })).toBeCloseTo(90, 10);
  });

  it("refuses a shallow window", () => {
    // A 5% discharge divides by 0.05, so a 2% SoC error — well within what a
    // BMS reports — becomes a 40% error in the answer.
    expect(capacityFromWindow({ socStart: 90, socEnd: 85, dischargedKwh: 4 })).toBeNull();
    expect(capacityFromWindow({ socStart: 90, socEnd: 90 - MIN_SOC_SPAN_PCT, dischargedKwh: 27 })).not.toBeNull();
  });

  it("refuses a window with no energy, or one that went the wrong way", () => {
    expect(capacityFromWindow({ socStart: 90, socEnd: 40, dischargedKwh: 0 })).toBeNull();
    expect(capacityFromWindow({ socStart: 40, socEnd: 90, dischargedKwh: 45 })).toBeNull();
  });
});

describe("sohPercent", () => {
  it("is a ratio of nameplate", () => {
    expect(sohPercent(90, 100)).toBeCloseTo(90, 10);
  });

  it("allows readings above 100 rather than hiding them", () => {
    // New batteries ship with margin — and a reading of 130 is a SIGN that the
    // nameplate is wrong or the sign convention inverted, which clamping to
    // 100 would conceal.
    expect(sohPercent(130, 100)).toBeCloseTo(130, 10);
    expect(sohPercent(1000, 100)).toBe(150);
  });

  it("returns null rather than dividing by a missing nameplate", () => {
    expect(sohPercent(90, 0)).toBeNull();
    expect(sohPercent(0, 100)).toBeNull();
  });
});

describe("blendSoh", () => {
  it("takes the first estimate as-is", () => {
    // Starting from an assumed 100% would make a tired battery look healthy
    // for weeks.
    expect(blendSoh(null, 82)).toBe(82);
  });

  it("moves slowly afterwards", () => {
    expect(blendSoh(90, 70, 0.2)).toBeCloseTo(86, 10);
  });

  it("clamps a nonsense alpha instead of amplifying", () => {
    expect(blendSoh(90, 70, 5)).toBeCloseTo(70, 10);
    expect(blendSoh(90, 70, -1)).toBeCloseTo(90, 10);
  });
});

describe("windowStep", () => {
  it("opens a window when discharging starts", () => {
    const s = windowStep(null, null, at(0, 95, 10));
    expect(s.kind).toBe("open");
    expect(s.next).toEqual({ socStart: 95, dischargedKwh: 0 });
  });

  it("stays idle while charging or resting", () => {
    expect(windowStep(null, null, at(0, 95, -10)).kind).toBe("idle");
    expect(windowStep(null, null, at(0, 95, 0)).kind).toBe("idle");
  });

  it("accumulates energy while the discharge continues", () => {
    const prev = at(0, 95, 10);
    const s = windowStep({ socStart: 95, dischargedKwh: 0 }, prev, at(6, 93, 10));
    expect(s.kind).toBe("accumulate");
    expect(s.next?.dischargedKwh).toBeCloseTo(1, 10);
  });

  it("closes the window when the battery stops discharging", () => {
    const s = windowStep({ socStart: 95, dischargedKwh: 40 }, at(0, 50, 10), at(5, 45, -5));
    expect(s.kind).toBe("close");
    expect(s.kind === "close" && s.window).toEqual({ socStart: 95, socEnd: 45, dischargedKwh: 40 });
  });

  it("abandons a window with a hole in the data, rather than reporting it", () => {
    // The integral is no longer a complete account of the energy, so the
    // window is closed with zero and rejected downstream.
    const s = windowStep({ socStart: 95, dischargedKwh: 40 }, at(0, 60, 10), at(120, 30, 10));
    expect(s.kind).toBe("close");
    expect(s.kind === "close" && s.window.dischargedKwh).toBe(0);
  });

  it("abandons a window with a hole in it even when the battery is resting afterwards", () => {
    // 40 kWh seen before a two-hour hole, SoC down to 30% by the time data
    // comes back with the battery at rest. Closing normally would divide the
    // whole 95 → 30 drop by only the 40 kWh seen, and report a battery that has
    // lost most of its capacity.
    const s = windowStep({ socStart: 95, dischargedKwh: 40 }, at(0, 60, 10), at(120, 30, 0));
    expect(s.kind).toBe("close");
    expect(s.kind === "close" && s.window.dischargedKwh).toBe(0);
    expect(s.kind === "close" && capacityFromWindow(s.window)).toBeNull();
  });

  it("treats a non-finite reading as unknown", () => {
    expect(windowStep(null, null, at(0, Number.NaN, 10)).kind).toBe("idle");
    const s = windowStep({ socStart: 95, dischargedKwh: 40 }, at(0, 60, 10), at(5, 55, Number.POSITIVE_INFINITY));
    expect(s.kind).toBe("close");
    expect(s.kind === "close" && s.window.dischargedKwh).toBe(0);
  });

  it("abandons a window when SoC goes unknown, instead of inventing an endpoint", () => {
    const s = windowStep({ socStart: 95, dischargedKwh: 40 }, at(0, 60, 10), at(5, null, 10));
    expect(s.kind).toBe("close");
    expect(s.kind === "close" && s.window.dischargedKwh).toBe(0);
    // Zero span too: nothing here can be turned into a capacity estimate.
    expect(s.kind === "close" && capacityFromWindow(s.window)).toBeNull();
  });

  it("a full discharge end to end yields a capacity estimate", () => {
    // 50 kW held for two hours while SoC falls 95% → 35%: 100 kWh out of 60%
    // of the battery implies about 167 kWh usable.
    let state = null as { socStart: number; dischargedKwh: number } | null;
    let prev: SocSample | null = null;
    let closed: { socStart: number; socEnd: number; dischargedKwh: number } | null = null;
    const samples: SocSample[] = [];
    for (let m = 0; m <= 120; m += 5) samples.push(at(m, 95 - (m / 120) * 60, 50));
    samples.push(at(125, 35, 0));
    for (const s of samples) {
      const step = windowStep(state, prev, s);
      if (step.kind === "close") closed = step.window;
      state = step.kind === "close" ? null : step.next;
      prev = s;
    }
    expect(closed).not.toBeNull();
    expect(closed!.dischargedKwh).toBeCloseTo(100, 6);
    expect(capacityFromWindow(closed!)).toBeCloseTo(166.67, 1);
  });
});

describe("sohReadRange", () => {
  const MIN = SOH_BUCKET_MS;
  const NOW = T0.getTime() + 600 * MIN; // 10:00
  const OLDEST = T0.getTime() - 90 * 86_400_000;

  it("starts a new battery at the retention cutoff", () => {
    const r = sohReadRange(null, NOW, OLDEST);
    expect(r?.firstBucketMs).toBe(OLDEST);
  });

  it("resumes at the bucket after the last one consumed", () => {
    const r = sohReadRange(T0.getTime() + 500 * MIN, NOW, OLDEST);
    expect(r?.firstBucketMs).toBe(T0.getTime() + 501 * MIN);
  });

  it("resumes after a cursor that sits inside a bucket", () => {
    // A cursor written by an older version holds a raw sample time.
    const r = sohReadRange(T0.getTime() + 500 * MIN + 27_000, NOW, OLDEST);
    expect(r?.firstBucketMs).toBe(T0.getTime() + 501 * MIN);
  });

  it("reads only closed buckets, held back by the grace period", () => {
    // At 10:00 with two minutes of grace, 09:57 is the last bucket that has
    // closed (it ended at 09:58).
    const r = sohReadRange(T0.getTime() + 500 * MIN, NOW, OLDEST, { graceMs: 2 * MIN });
    expect(r?.lastBucketMs).toBe(T0.getTime() + 597 * MIN);
  });

  it("returns nothing when no new bucket has closed", () => {
    expect(sohReadRange(T0.getTime() + 597 * MIN, NOW, OLDEST, { graceMs: 2 * MIN })).toBeNull();
  });

  it("caps one sweep at a page", () => {
    const r = sohReadRange(null, NOW, OLDEST, { maxBuckets: 100 });
    expect(r).toEqual({ firstBucketMs: OLDEST, lastBucketMs: OLDEST + 99 * MIN });
  });

  it("skips history that retention has already purged", () => {
    const r = sohReadRange(OLDEST - 30 * 86_400_000, NOW, OLDEST);
    expect(r?.firstBucketMs).toBe(OLDEST);
  });
});

describe("samplesFromBuckets", () => {
  const range = { firstBucketMs: T0.getTime(), lastBucketMs: T0.getTime() + 2 * SOH_BUCKET_MS };
  const bucket = (min: number, values: Record<string, number | null>) => ({
    bucketStartSec: (T0.getTime() + min * 60_000) / 1000,
    values,
  });

  it("keeps the range and drops the bucket after it", () => {
    // The store is asked up to the start of the next bucket; whatever lands in
    // it is left for the next sweep rather than read half-full now.
    const out = samplesFromBuckets(
      [bucket(0, { socPercent: 90, batteryPowerKw: 5 }), bucket(2, { socPercent: 88, batteryPowerKw: 5 }), bucket(3, { socPercent: 87, batteryPowerKw: 5 })],
      range,
    );
    expect(out.map((s) => s.ts.getTime())).toEqual([T0.getTime(), T0.getTime() + 2 * 60_000]);
  });

  it("orders by time", () => {
    const out = samplesFromBuckets([bucket(2, { socPercent: 88, batteryPowerKw: 5 }), bucket(0, { socPercent: 90, batteryPowerKw: 5 })], range);
    expect(out.map((s) => s.socPercent)).toEqual([90, 88]);
  });

  it("turns missing and non-finite readings into null", () => {
    const out = samplesFromBuckets([bucket(0, { socPercent: Number.NaN }), bucket(1, { batteryPowerKw: null })], range);
    expect(out).toEqual([
      { ts: new Date(T0.getTime()), socPercent: null, batteryPowerKw: null },
      { ts: new Date(T0.getTime() + 60_000), socPercent: null, batteryPowerKw: null },
    ]);
  });
});

describe("cursorAfterSilence", () => {
  const MIN = 60_000;
  const range = (lastMin: number) => ({ firstBucketMs: T0.getTime() + MIN, lastBucketMs: T0.getTime() + lastMin * MIN });

  it("stays put through a short silence, so the next sample still joins up", () => {
    expect(cursorAfterSilence(T0.getTime(), range(5))).toBeNull();
  });

  it("moves past a silence too long for anything to survive", () => {
    // Without this, a battery offline for longer than a page would re-read
    // the same empty page every sweep and never get past the hole.
    expect(cursorAfterSilence(T0.getTime(), range(30))).toBe(T0.getTime() + 30 * MIN);
  });

  it("moves a new battery's cursor through empty history", () => {
    expect(cursorAfterSilence(null, range(5))).toBe(T0.getTime() + 5 * MIN);
  });
});
