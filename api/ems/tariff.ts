// §9.3: tariff-aware optimisation.
//
// The EMS could discharge on a schedule and shave a peak. Neither knows what
// electricity costs, so the one thing a battery is bought for on a commercial
// site — buying energy when it is cheap and using it when it is dear — had to
// be approximated by a human writing time windows by hand and editing them
// whenever the contract changed.
//
// Two price sources, because both exist in the field and neither covers the
// other: a time-of-use schedule (what most industrial supply contracts are)
// and an imported hourly curve (what a market-exposed site needs, day-ahead).
// An explicit hourly price always wins over the schedule; where neither says
// anything, THERE IS NO PRICE, and the optimiser refuses to plan rather than
// guessing one.
//
// Everything here is pure. The planner emits setpoints for the existing
// ems_plans path (v9 Contract A), so the controller, the SoC guard, the
// whitelist and the audit trail are all unchanged — this adds a planner, not a
// second thing that commands plant.
import { localClock } from "@contracts/tz";

export interface TariffPeriod {
  dayOfWeekMask: number;
  startMin: number;
  endMin: number;
  importPrice: number;
  exportPrice: number | null;
}

export interface ExplicitPrice {
  /** Hour start, UTC. */
  hourStartMs: number;
  importPrice: number;
  exportPrice: number | null;
}

export interface Price {
  importPrice: number;
  exportPrice: number | null;
  source: "explicit" | "schedule";
}

/** Same window semantics as ems_schedules: bit 0 = Sunday, equal start and end
 *  means all day, an end before the start wraps past midnight. */
function periodCovers(p: TariffPeriod, dow: number, min: number): boolean {
  if (((p.dayOfWeekMask >> dow) & 1) === 0) return false;
  if (p.startMin === p.endMin) return true;
  if (p.startMin < p.endMin) return min >= p.startMin && min < p.endMin;
  return min >= p.startMin || min < p.endMin;
}

/**
 * The price for one instant, or null when nothing covers it.
 *
 * Null is the important case. A missing price is not zero and not "average":
 * either would have the optimiser cheerfully plan a cycle on a number nobody
 * supplied, and the whole feature's value rests on the numbers being real.
 */
export function priceAt(
  tsMs: number,
  periods: TariffPeriod[],
  explicit: ExplicitPrice[],
  timezone = "UTC",
): Price | null {
  const hourStart = Math.floor(tsMs / 3_600_000) * 3_600_000;
  const hit = explicit.find((e) => e.hourStartMs === hourStart);
  if (hit) return { importPrice: hit.importPrice, exportPrice: hit.exportPrice, source: "explicit" };
  const { dow, min } = localClock(timezone, new Date(tsMs));
  // Later periods win, so a narrow exception listed after a broad default
  // overrides it rather than being shadowed by it.
  let found: TariffPeriod | null = null;
  for (const p of periods) {
    if (periodCovers(p, dow, min)) found = p;
  }
  return found ? { importPrice: found.importPrice, exportPrice: found.exportPrice, source: "schedule" } : null;
}

export interface PriceHour {
  hourStartMs: number;
  price: Price;
}

/** Hourly price curve over [fromMs, toMs). Hours with no price are OMITTED
 *  rather than filled, so the planner can see the hole. */
export function priceCurve(
  fromMs: number,
  toMs: number,
  periods: TariffPeriod[],
  explicit: ExplicitPrice[],
  timezone = "UTC",
): PriceHour[] {
  const out: PriceHour[] = [];
  const first = Math.floor(fromMs / 3_600_000) * 3_600_000;
  for (let h = first; h < toMs; h += 3_600_000) {
    const price = priceAt(h, periods, explicit, timezone);
    if (price) out.push({ hourStartMs: h, price });
  }
  return out;
}

// ─── Planning ────────────────────────────────────────────────────────────────
export interface BatteryLimits {
  /** Usable energy, kWh. */
  capacityKwh: number;
  /** Maximum charge/discharge power, kW. */
  maxPowerKw: number;
  /** Round-trip efficiency, 0–1. */
  roundTripEfficiency: number;
  minSocPct: number;
  maxSocPct: number;
  /**
   * What one equivalent full cycle costs in wear, in currency.
   *
   * This is the number that decides whether arbitrage is worth doing at all,
   * and it is the reason this planner refuses work that looks profitable. A
   * battery has a finite number of cycles in it; spending one to capture a
   * spread smaller than the wear it costs loses money while every chart says
   * the plan was a success. Zero means "wear is somebody else's problem",
   * which is a legitimate configuration for a leased asset but has to be
   * chosen rather than defaulted into.
   */
  cycleCost: number;
}

export interface PlanSetpoint {
  ts: string;
  kw: number;
}

export interface PlanResult {
  setpoints: PlanSetpoint[];
  /** Expected gross margin, before wear. */
  grossMargin: number;
  /** Wear charged against the plan. */
  wearCost: number;
  /** What the plan is expected to earn after wear. Never negative: a plan that
   *  does not clear its own wear is not emitted at all. */
  netMargin: number;
  /** Why the plan is empty, when it is. */
  reason: string | null;
}

/**
 * Minimum price spread per kWh that makes one charge/discharge pair worth it.
 *
 * Two costs stack. Round-trip losses mean 1 kWh bought delivers only
 * `efficiency` kWh, so the buy price has to be beaten by more than the
 * nominal difference. And wear is charged per kWh cycled, from `cycleCost`
 * spread over the capacity it takes to make one full cycle.
 */
export function minProfitableSpread(limits: BatteryLimits, buyPrice: number): number {
  const eff = Math.min(1, Math.max(0.01, limits.roundTripEfficiency));
  const wearPerKwh = limits.capacityKwh > 0 ? limits.cycleCost / limits.capacityKwh : 0;
  // Selling `eff` kWh must cover buying 1 kWh plus the wear of moving it.
  return (buyPrice * (1 - eff)) / eff + wearPerKwh / eff;
}

/**
 * Pair the cheapest hours with the dearest ones and emit setpoints.
 *
 * Greedy pairing rather than a solver: cheapest-buy against dearest-sell,
 * taking pairs only while they clear the spread above, and only while the
 * sell hour comes AFTER the buy hour — energy cannot be discharged before it
 * has been stored, which a naive "charge in the cheap hours, discharge in the
 * dear ones" ranking happily ignores.
 *
 * One hour is one setpoint at full power or nothing. Partial-hour modulation
 * would need a finer plan than the controller consumes, and pretending to a
 * precision the execution path does not have is worse than being coarse.
 */
export function planArbitrage(curve: PriceHour[], limits: BatteryLimits): PlanResult {
  const empty = (reason: string): PlanResult => ({
    setpoints: [],
    grossMargin: 0,
    wearCost: 0,
    netMargin: 0,
    reason,
  });
  if (curve.length < 2) return empty("not enough priced hours to plan against");
  if (!(limits.capacityKwh > 0) || !(limits.maxPowerKw > 0)) return empty("battery capacity or power not configured");

  const usableFraction = Math.max(0, Math.min(100, limits.maxSocPct) - Math.max(0, limits.minSocPct)) / 100;
  const usableKwh = limits.capacityKwh * usableFraction;
  if (!(usableKwh > 0)) return empty("SoC limits leave no usable energy");

  // Energy movable in one hour at full power, capped by what the battery can
  // hold between its SoC limits.
  const perHourKwh = Math.min(limits.maxPowerKw, usableKwh);
  const maxPairs = Math.max(1, Math.floor(usableKwh / perHourKwh));

  const byPrice = [...curve].sort((a, b) => a.price.importPrice - b.price.importPrice);
  const used = new Set<number>();
  const charge: PriceHour[] = [];
  const discharge: PriceHour[] = [];
  let gross = 0;

  for (let i = 0; i < maxPairs; i++) {
    const buy = byPrice.find((h) => !used.has(h.hourStartMs));
    if (!buy) break;
    // The sell hour must come after the buy hour: stored energy cannot be
    // discharged before it was stored.
    const sellCandidates = curve
      .filter((h) => !used.has(h.hourStartMs) && h.hourStartMs > buy.hourStartMs)
      .sort((a, b) => sellPrice(b) - sellPrice(a));
    const sell = sellCandidates[0];
    if (!sell) break;
    const spread = sellPrice(sell) - buy.price.importPrice;
    if (spread <= minProfitableSpread(limits, buy.price.importPrice)) break;
    used.add(buy.hourStartMs);
    used.add(sell.hourStartMs);
    charge.push(buy);
    discharge.push(sell);
    const delivered = perHourKwh * Math.min(1, Math.max(0.01, limits.roundTripEfficiency));
    gross += delivered * sellPrice(sell) - perHourKwh * buy.price.importPrice;
  }

  if (charge.length === 0) {
    return empty("no hour pair clears the cost of a cycle");
  }

  // Wear: each pair moves perHourKwh through the battery, which is
  // perHourKwh/capacity of an equivalent full cycle.
  const cycles = (charge.length * perHourKwh) / limits.capacityKwh;
  const wearCost = cycles * limits.cycleCost;
  const net = gross - wearCost;
  if (net <= 0) {
    // Belt and braces: the per-pair test should already have stopped this, but
    // a plan that loses money must never reach plant on a rounding edge.
    return empty("plan does not clear its own wear once losses are counted");
  }

  const setpoints: PlanSetpoint[] = [
    ...charge.map((h) => ({ ts: new Date(h.hourStartMs).toISOString(), kw: -perHourKwh })),
    ...discharge.map((h) => ({ ts: new Date(h.hourStartMs).toISOString(), kw: perHourKwh })),
  ].sort((a, b) => a.ts.localeCompare(b.ts));

  return { setpoints, grossMargin: gross, wearCost, netMargin: net, reason: null };
}

/**
 * The price a discharged kWh earns.
 *
 * Behind the meter a discharged kWh first AVOIDS an import, so it is worth the
 * import price; it is only worth the export price when export pays better,
 * which is rare but happens on some feed-in contracts. Conflating the two is
 * how a plan looks profitable at an export tariff a third of the retail rate.
 *
 * This assumes the site has load to absorb the discharge, which is the normal
 * case for a commercial site at a peak-price hour. A site that genuinely
 * exports its discharge should carry an export price, and then the comparison
 * below picks it.
 */
export function sellPrice(h: PriceHour): number {
  return h.price.exportPrice !== null && h.price.exportPrice > h.price.importPrice
    ? h.price.exportPrice
    : h.price.importPrice;
}
