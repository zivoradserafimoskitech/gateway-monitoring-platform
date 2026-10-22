// §9.3: tariff-aware optimisation. The arithmetic decides whether a battery
// worth six figures is cycled, so the cases that matter are the ones where a
// naive planner would cheerfully lose money.
import { describe, it, expect } from "vitest";
import {
  minProfitableSpread,
  pickTariff,
  planArbitrage,
  priceAt,
  priceCurve,
  sellPrice,
  type BatteryLimits,
  type PriceHour,
  type TariffPeriod,
} from "../api/ems/tariff";

const H = 3_600_000;
const DAY = new Date("2026-03-10T00:00:00Z").getTime(); // a Tuesday (dow 2)

const period = (over: Partial<TariffPeriod> = {}): TariffPeriod => ({
  dayOfWeekMask: 0b1111111,
  startMin: 0,
  endMin: 0,
  importPrice: 0.1,
  exportPrice: null,
  ...over,
});

describe("priceAt", () => {
  it("reads an all-day period", () => {
    expect(priceAt(DAY + 9 * H, [period()], [])).toEqual({ importPrice: 0.1, exportPrice: null, source: "schedule" });
  });

  it("returns null when nothing covers the hour", () => {
    // A missing price is not zero and not an average: either would have the
    // optimiser plan a cycle on a number nobody supplied.
    const peakOnly = [period({ startMin: 17 * 60, endMin: 21 * 60 })];
    expect(priceAt(DAY + 9 * H, peakOnly, [])).toBeNull();
    expect(priceAt(DAY + 18 * H, peakOnly, [])).not.toBeNull();
  });

  it("lets a later period override an earlier one", () => {
    // A narrow exception listed after a broad default must win rather than
    // being shadowed by it.
    const rows = [period({ importPrice: 0.1 }), period({ startMin: 17 * 60, endMin: 21 * 60, importPrice: 0.4 })];
    expect(priceAt(DAY + 18 * H, rows, [])?.importPrice).toBe(0.4);
    expect(priceAt(DAY + 9 * H, rows, [])?.importPrice).toBe(0.1);
  });

  it("an explicit hourly price beats the schedule", () => {
    const got = priceAt(DAY + 9 * H, [period({ importPrice: 0.1 })], [
      { hourStartMs: DAY + 9 * H, importPrice: 0.33, exportPrice: 0.05 },
    ]);
    expect(got).toEqual({ importPrice: 0.33, exportPrice: 0.05, source: "explicit" });
  });

  it("respects the day mask", () => {
    // 2026-03-10 is a Tuesday (bit 2).
    expect(priceAt(DAY + 9 * H, [period({ dayOfWeekMask: 1 << 1 })], [])).toBeNull();
    expect(priceAt(DAY + 9 * H, [period({ dayOfWeekMask: 1 << 2 })], [])).not.toBeNull();
  });

  it("reads periods in the tariff's own zone", () => {
    // 16:00 UTC is 18:00 in Skopje (summer +2): inside a 17:00–21:00 local peak.
    const peak = [period({ startMin: 17 * 60, endMin: 21 * 60, importPrice: 0.4 })];
    const july = new Date("2026-07-14T16:00:00Z").getTime();
    expect(priceAt(july, peak, [], "Europe/Skopje")?.importPrice).toBe(0.4);
    expect(priceAt(july, peak, [], "UTC")).toBeNull();
  });

  it("a wrapping night period covers both sides of midnight", () => {
    const night = [period({ startMin: 22 * 60, endMin: 6 * 60, importPrice: 0.05 })];
    expect(priceAt(DAY + 23 * H, night, [])?.importPrice).toBe(0.05);
    expect(priceAt(DAY + 2 * H, night, [])?.importPrice).toBe(0.05);
    expect(priceAt(DAY + 12 * H, night, [])).toBeNull();
  });
});

describe("priceCurve", () => {
  it("omits unpriced hours instead of filling them", () => {
    const peakOnly = [period({ startMin: 17 * 60, endMin: 21 * 60 })];
    const curve = priceCurve(DAY, DAY + 24 * H, peakOnly, []);
    expect(curve).toHaveLength(4);
    expect(curve.map((c) => new Date(c.hourStartMs).getUTCHours())).toEqual([17, 18, 19, 20]);
  });

  it("covers the whole range when the tariff does", () => {
    expect(priceCurve(DAY, DAY + 24 * H, [period()], [])).toHaveLength(24);
  });
});

const limits = (over: Partial<BatteryLimits> = {}): BatteryLimits => ({
  capacityKwh: 100,
  maxPowerKw: 50,
  roundTripEfficiency: 0.9,
  minSocPct: 10,
  maxSocPct: 90,
  cycleCost: 0,
  ...over,
});

const hour = (h: number, importPrice: number, exportPrice: number | null = null): PriceHour => ({
  hourStartMs: DAY + h * H,
  price: { importPrice, exportPrice, source: "schedule" },
});

describe("minProfitableSpread", () => {
  it("charges for round-trip losses even with no wear cost", () => {
    // At 90% efficiency, buying at 0.10 means 0.9 kWh comes back out, so the
    // sell price has to beat the buy price by more than the loss.
    const s = minProfitableSpread(limits({ cycleCost: 0 }), 0.1);
    expect(s).toBeCloseTo((0.1 * 0.1) / 0.9, 10);
  });

  it("charges for wear on top", () => {
    // 2000 per cycle over 100 kWh = 20 per kWh of wear, which dwarfs any
    // plausible energy spread — exactly the case that should stop a cycle.
    expect(minProfitableSpread(limits({ cycleCost: 2000 }), 0.1)).toBeGreaterThan(20);
  });

  it("does not divide by a zero or absurd efficiency", () => {
    expect(Number.isFinite(minProfitableSpread(limits({ roundTripEfficiency: 0 }), 0.1))).toBe(true);
    expect(Number.isFinite(minProfitableSpread(limits({ roundTripEfficiency: 5 }), 0.1))).toBe(true);
  });
});

describe("planArbitrage", () => {
  it("buys cheap and sells dear", () => {
    const curve = [hour(2, 0.05), hour(18, 0.40)];
    const r = planArbitrage(curve, limits({ maxPowerKw: 80 }));
    expect(r.reason).toBeNull();
    expect(r.setpoints).toHaveLength(2);
    // Charge is negative, discharge positive, and the charge comes first.
    expect(r.setpoints[0].kw).toBeLessThan(0);
    expect(r.setpoints[1].kw).toBeGreaterThan(0);
    expect(r.netMargin).toBeGreaterThan(0);
  });

  it("never discharges before it has charged", () => {
    // The dearest hour is in the MORNING here, before the cheapest. A planner
    // that just ranks hours would plan to discharge energy it has not stored.
    const curve = [hour(6, 0.40), hour(20, 0.05)];
    const r = planArbitrage(curve, limits({ maxPowerKw: 80 }));
    expect(r.setpoints).toEqual([]);
    expect(r.reason).not.toBeNull();
  });

  it("refuses a spread that does not clear the cost of a cycle", () => {
    // 0.05 → 0.10 looks like a 100% gain and loses money once wear is counted.
    const curve = [hour(2, 0.05), hour(18, 0.10)];
    const r = planArbitrage(curve, limits({ cycleCost: 50 }));
    expect(r.setpoints).toEqual([]);
    expect(r.reason).toContain("cost of a cycle");
    expect(r.netMargin).toBe(0);
  });

  it("takes the same spread once wear is somebody else's problem", () => {
    // A leased asset can legitimately set cycleCost to zero — but it has to be
    // chosen, which is why the default is not zero-cost cycling.
    const curve = [hour(2, 0.05), hour(18, 0.10)];
    expect(planArbitrage(curve, limits({ cycleCost: 0 })).setpoints).toHaveLength(2);
  });

  it("plans several pairs when the battery needs several hours to fill", () => {
    // 80 kWh usable at 20 kW takes four hours, so up to four pairs.
    const curve = [
      hour(0, 0.04),
      hour(1, 0.05),
      hour(2, 0.06),
      hour(3, 0.07),
      hour(17, 0.50),
      hour(18, 0.52),
      hour(19, 0.48),
      hour(20, 0.46),
    ];
    const r = planArbitrage(curve, limits({ maxPowerKw: 20 }));
    expect(r.setpoints).toHaveLength(8);
    expect(r.setpoints.filter((s) => s.kw < 0)).toHaveLength(4);
  });

  it("caps a pair at the power the battery actually has", () => {
    const r = planArbitrage([hour(2, 0.05), hour(18, 0.5)], limits({ maxPowerKw: 30 }));
    expect(Math.abs(r.setpoints[0].kw)).toBe(30);
  });

  it("caps at the usable energy when power exceeds it", () => {
    // 50 kW into a battery with only 20 kWh usable: one hour at 20 kW, not 50.
    const r = planArbitrage([hour(2, 0.05), hour(18, 0.5)], limits({ minSocPct: 40, maxSocPct: 60 }));
    expect(Math.abs(r.setpoints[0].kw)).toBe(20);
  });

  it("refuses when SoC limits leave nothing usable", () => {
    const r = planArbitrage([hour(2, 0.05), hour(18, 0.5)], limits({ minSocPct: 50, maxSocPct: 50 }));
    expect(r.reason).toContain("usable energy");
  });

  it("refuses without a configured capacity or power", () => {
    expect(planArbitrage([hour(2, 0.05), hour(18, 0.5)], limits({ capacityKwh: 0 })).reason).toContain("not configured");
    expect(planArbitrage([hour(2, 0.05), hour(18, 0.5)], limits({ maxPowerKw: 0 })).reason).toContain("not configured");
  });

  it("refuses with fewer than two priced hours", () => {
    expect(planArbitrage([hour(2, 0.05)], limits()).reason).toContain("not enough priced hours");
    expect(planArbitrage([], limits()).reason).toContain("not enough priced hours");
  });

  it("reports wear against the plan it emitted", () => {
    const r = planArbitrage([hour(2, 0.01), hour(18, 1.0)], limits({ maxPowerKw: 50, cycleCost: 10 }));
    expect(r.setpoints).toHaveLength(2);
    // Half the capacity moved = half a cycle = half the cycle cost.
    expect(r.wearCost).toBeCloseTo(5, 10);
    expect(r.netMargin).toBeCloseTo(r.grossMargin - r.wearCost, 10);
  });

  it("a cheap hour at the end of the horizon does not wipe out the plan", () => {
    // 23:00 is the cheapest hour and has nothing after it to sell into. The
    // first version stopped searching there, so the good 02:00 → 18:00 pair
    // was never tried and the plan came back empty.
    const r = planArbitrage([hour(2, 0.1), hour(18, 0.5), hour(23, 0.01)], limits({ maxPowerKw: 80 }));
    expect(r.reason).toBeNull();
    expect(r.setpoints.map((s) => new Date(s.ts).getUTCHours())).toEqual([2, 18]);
    expect(r.netMargin).toBeGreaterThan(0);
  });

  it("skips a buy whose best sell is too thin and keeps looking", () => {
    // The cheapest hour (20:00) can only sell into 22:00, a spread that does
    // not cover the round-trip loss. A pricier hour earlier in the day still
    // has a good sell, and that pair must be found.
    const curve = [hour(3, 0.08), hour(18, 0.5), hour(20, 0.02), hour(22, 0.021)];
    const r = planArbitrage(curve, limits({ maxPowerKw: 80 }));
    expect(r.reason).toBeNull();
    expect(r.setpoints.map((s) => new Date(s.ts).getUTCHours())).toEqual([3, 18]);
  });

  it("discharges what the charge left in the battery, not what was bought", () => {
    // 30 kW in at 90% round trip gives back 27 kW for the hour. Commanding 30
    // would run the battery into its SoC floor before the hour is out.
    const r = planArbitrage([hour(2, 0.05), hour(18, 0.5)], limits({ maxPowerKw: 30 }));
    expect(r.setpoints.map((s) => s.kw)).toEqual([-30, 27]);
    // And the margin is counted on the same 27 kWh.
    expect(r.grossMargin).toBeCloseTo(27 * 0.5 - 30 * 0.05, 10);
  });
});

describe("sellPrice", () => {
  it("values a discharged kWh at the import it avoids", () => {
    expect(sellPrice(hour(18, 0.4, 0.05))).toBe(0.4);
  });

  it("prefers the export price only when export pays better", () => {
    expect(sellPrice(hour(18, 0.1, 0.3))).toBe(0.3);
  });

  it("handles an unpaid export", () => {
    expect(sellPrice(hour(18, 0.4, null))).toBe(0.4);
  });
});

describe("pickTariff", () => {
  const t = (id: number, siteId: number | null, orgId: number | null) => ({ id, siteId, orgId });

  it("prefers the site's own tariff, then the org default, then a global one", () => {
    const rows = [t(1, null, null), t(2, null, 7), t(3, 40, 7)];
    expect(pickTariff(rows, 40, 7)?.id).toBe(3);
    expect(pickTariff(rows.slice(0, 2), 40, 7)?.id).toBe(2);
    expect(pickTariff(rows.slice(0, 1), 40, 7)?.id).toBe(1);
  });

  it("does not depend on the order the rows came back in", () => {
    // The first version took the first org-or-global row it met, so the org
    // default and a global one swapped places with the database's row order.
    const a = [t(1, null, null), t(2, null, 7)];
    expect(pickTariff(a, 40, 7)?.id).toBe(2);
    expect(pickTariff([...a].reverse(), 40, 7)?.id).toBe(2);
  });

  it("takes the most recent of several at the same level", () => {
    expect(pickTariff([t(5, 40, 7), t(9, 40, 7), t(6, 40, 7)], 40, 7)?.id).toBe(9);
  });

  it("never applies another site's or another org's tariff", () => {
    expect(pickTariff([t(1, 41, 7)], 40, 7)).toBeNull();
    expect(pickTariff([t(1, null, 8)], 40, 7)).toBeNull();
    expect(pickTariff([t(1, 40, 8)], 40, 7)).toBeNull();
  });

  it("gives a device with no site or org only the global default", () => {
    expect(pickTariff([t(1, null, 7), t(2, null, null)], null, null)?.id).toBe(2);
    expect(pickTariff([t(1, 40, null)], null, null)).toBeNull();
  });

  it("returns null when nothing applies", () => {
    expect(pickTariff([], 40, 7)).toBeNull();
  });
});
