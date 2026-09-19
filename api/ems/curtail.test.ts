// §9.2: the arithmetic behind the grid connection limit. Driven exactly here
// so the behaviour that matters — a breach answered at once, capacity given
// back slowly, priority obeyed — does not have to be observed on a live site.
import { describe, it, expect } from "vitest";
import {
  allocateCurtailment,
  gridStatus,
  limitPct,
  stepCurtailment,
  type CurtailAsset,
  type GridLimits,
} from "./curtail";

const limits: GridLimits = { maxImportKw: 200, maxExportKw: 100, deadbandKw: 10, maxStepKw: 50 };

describe("gridStatus", () => {
  it("reads the sign convention the way the meter does", () => {
    // Positive is import, negative is export. Getting this backwards would
    // curtail generation when the site is drawing too much, which makes the
    // breach worse rather than better — hence a test that pins the direction.
    expect(gridStatus(150, limits).state).toBe("ok");
    expect(gridStatus(250, limits).state).toBe("over-import");
    expect(gridStatus(-150, limits).state).toBe("over-export");
  });

  it("measures the excess, not just the fact", () => {
    expect(gridStatus(-130, limits).excessKw).toBe(30);
    expect(gridStatus(260, limits).excessKw).toBe(60);
  });

  it("offers no headroom until the deadband is cleared", () => {
    // Exactly at the limit there is room by arithmetic but not by prudence:
    // releasing here puts the site straight back over on the next cloud edge.
    expect(gridStatus(-100, limits).headroomKw).toBe(0);
    expect(gridStatus(-95, limits).headroomKw).toBe(0);
    expect(gridStatus(-80, limits).headroomKw).toBe(10);
  });

  it("takes the tighter of the two limits when both bind", () => {
    const g = gridStatus(0, limits);
    expect(g.headroomKw).toBe(90); // export side: 100 − 0 − 10
  });

  it("treats a null limit as no limit at all", () => {
    const exportOnly: GridLimits = { ...limits, maxImportKw: null };
    expect(gridStatus(10_000, exportOnly).state).toBe("ok");
  });
});

describe("stepCurtailment", () => {
  it("answers a breach immediately, up to the step cap", () => {
    const status = gridStatus(-130, limits); // 30 kW over
    expect(stepCurtailment(0, status, limits)).toBe(30);
  });

  it("never slams shut on a spike", () => {
    // A single wild reading must not take the whole array offline in one tick.
    const status = gridStatus(-500, limits); // 400 kW over
    expect(stepCurtailment(0, status, limits)).toBe(50);
  });

  it("gives capacity back only as fast as the headroom allows", () => {
    const status = gridStatus(-80, limits); // 10 kW of headroom
    expect(stepCurtailment(40, status, limits)).toBe(30);
  });

  it("holds curtailment while inside the deadband", () => {
    // The whole point of the deadband: no movement in the quiet zone, so the
    // loop does not hunt around the limit and write setpoints forever.
    const status = gridStatus(-95, limits);
    expect(stepCurtailment(40, status, limits)).toBe(40);
  });

  it("releases when the site is over its IMPORT limit", () => {
    // Generation held back is making the import worse, so the lever runs the
    // other way here — this is the case a one-directional design gets wrong.
    const status = gridStatus(250, limits); // 50 kW over on import
    expect(stepCurtailment(40, status, limits)).toBe(0);
  });

  it("never goes negative", () => {
    const status = gridStatus(0, limits);
    expect(stepCurtailment(0, status, limits)).toBe(0);
    expect(stepCurtailment(5, status, { ...limits, maxStepKw: 1000 })).toBe(0);
  });
});

describe("allocateCurtailment", () => {
  const assets: CurtailAsset[] = [
    { meterId: 2, priority: 2, ratedKw: 100, outputKw: 80 },
    { meterId: 1, priority: 1, ratedKw: 50, outputKw: 40 },
  ];

  it("exhausts the first priority before touching the second", () => {
    // The priority column exists to be obeyed: proportional sharing would
    // quietly override an operator who ranked a leased array above an owned one.
    const out = allocateCurtailment(30, assets);
    expect(out.map((a) => [a.meterId, a.takeKw])).toEqual([
      [1, 30],
      [2, 0],
    ]);
  });

  it("spills over once the first is fully curtailed", () => {
    const out = allocateCurtailment(60, assets);
    expect(out.map((a) => [a.meterId, a.takeKw])).toEqual([
      [1, 40],
      [2, 20],
    ]);
  });

  it("caps each asset at what it is actually producing", () => {
    // Asking an inverter making 40 kW to hold back 200 achieves 40.
    const out = allocateCurtailment(500, assets);
    expect(out.reduce((s, a) => s + a.takeKw, 0)).toBe(120);
  });

  it("passes over an asset whose output is unknown", () => {
    // Assigning a share to a device that may not be running would leave the
    // breach unanswered while the arithmetic said it was handled.
    const out = allocateCurtailment(30, [
      { meterId: 1, priority: 1, ratedKw: 50, outputKw: null },
      { meterId: 2, priority: 2, ratedKw: 100, outputKw: 80 },
    ]);
    expect(out.find((a) => a.meterId === 1)!.takeKw).toBe(0);
    expect(out.find((a) => a.meterId === 2)!.takeKw).toBe(30);
  });

  it("breaks a priority tie deterministically", () => {
    // Two assets at the same priority must not swap places between ticks, or
    // the controller writes setpoints forever without changing anything.
    const tied: CurtailAsset[] = [
      { meterId: 9, priority: 1, ratedKw: 10, outputKw: 10 },
      { meterId: 3, priority: 1, ratedKw: 10, outputKw: 10 },
    ];
    expect(allocateCurtailment(5, tied)[0].meterId).toBe(3);
  });
});

describe("limitPct", () => {
  it("turns a share into the register's percentage", () => {
    expect(limitPct({ meterId: 1, takeKw: 25, ratedKw: 100 })).toBe(75);
    expect(limitPct({ meterId: 1, takeKw: 0, ratedKw: 100 })).toBe(100);
    expect(limitPct({ meterId: 1, takeKw: 100, ratedKw: 100 })).toBe(0);
  });

  it("clamps rather than trusting the arithmetic", () => {
    expect(limitPct({ meterId: 1, takeKw: 150, ratedKw: 100 })).toBe(0);
  });

  it("asks for no limit when the rating is unknown", () => {
    // A profile without a rating is not configured for curtailment. Inventing
    // a limit for it is how a site loses generation it never had to give up.
    expect(limitPct({ meterId: 1, takeKw: 10, ratedKw: 0 })).toBe(100);
  });
});
