// §9.3: the planner that turns a tariff into an EMS plan.
//
// FALLBACK ONLY. Economic optimisation (prices, forecast, arbitrage, battery
// economics) is owned by VoltTrade, which pushes plans through
// PUT /api/v1/devices/:id/ems-plan. This local time-of-use planner runs only
// when a device has no valid, fresh external plan (see plan-source.ts:
// EMS_EXTERNAL_PLAN_MAX_AGE_MIN, EMS_LOCAL_OPTIMIZER=fallback|off), so a
// device keeps a sane schedule if the link to VoltTrade is down. The tariff
// and battery_economics tables it reads are DEPRECATED as commercial data and
// kept only as the simple TOU profile this fallback needs
// (docs/ems-ownership.md).
//
// It writes ems_plans rows through the SAME path the external optimiser uses
// (v9 Contract A), so the controller, the fail-closed SoC guard, the
// controllable whitelist, the verification gate and the command audit trail
// are all unchanged. This adds a planner, not a second thing that commands
// plant — and that is the whole reason it is safe to add at all.
import { and, asc, eq, gt, gte, isNull, lte, or } from "drizzle-orm";
import { getDb } from "../queries/connection";
import {
  batteryEconomics,
  batteryHealth,
  emsPlans,
  meters,
  tariffPeriods,
  tariffPrices,
  tariffs,
} from "@db/schema";
import { withLease } from "../lib/leader";
import { externalPlanMaxAgeMs, isFreshExternal, localOptimizerMode } from "./plan-source";
import { pickTariff, planArbitrage, priceCurve, type BatteryLimits, type PlanResult } from "./tariff";

/** How far ahead to plan. A day-ahead market publishes a day; a time-of-use
 *  contract repeats, so more horizon adds nothing but churn. */
const HORIZON_H = parseInt(process.env.OPTIMIZER_HORIZON_HOURS || "24", 10);
const SWEEP_MS = 15 * 60_000;

/** The tariff that applies to a battery: its site's, else the org default,
 *  else a global one — see pickTariff for the rule. */
async function tariffFor(siteId: number | null, orgId: number | null) {
  const db = getDb();
  const rows = await db
    .select()
    .from(tariffs)
    .where(
      and(
        eq(tariffs.enabled, true),
        orgId === null ? isNull(tariffs.orgId) : or(eq(tariffs.orgId, orgId), isNull(tariffs.orgId)),
        siteId === null ? isNull(tariffs.siteId) : or(eq(tariffs.siteId, siteId), isNull(tariffs.siteId)),
      ),
    );
  return pickTariff(rows, siteId, orgId);
}

export interface OptimizeOutcome {
  meterId: number;
  plan: PlanResult | null;
  /** Null when a plan was written; otherwise why not. */
  skipped: string | null;
}

/**
 * Build (and store) a plan for one battery.
 *
 * `dryRun` returns the plan without writing it, which is what the UI preview
 * uses: an operator should be able to see what the optimiser WOULD do before
 * letting it do it, and the preview must come from the same function as the
 * real thing or it is worth nothing.
 */
export async function optimizeBattery(meterId: number, dryRun = false, now = new Date()): Promise<OptimizeOutcome> {
  const db = getDb();
  const econRows = await db.select().from(batteryEconomics).where(eq(batteryEconomics.meterId, meterId)).limit(1);
  const econ = econRows[0];
  if (!econ) return { meterId, plan: null, skipped: "no economics configured for this battery" };
  if (!dryRun && !econ.optimizerEnabled) return { meterId, plan: null, skipped: "optimizer disabled" };

  const meterRows = await db
    .select({ id: meters.id, siteId: meters.siteId, orgId: meters.orgId })
    .from(meters)
    .where(eq(meters.id, meterId))
    .limit(1);
  const meter = meterRows[0];
  if (!meter) return { meterId, plan: null, skipped: "device not found" };

  if (!dryRun) {
    if (localOptimizerMode() === "off") return { meterId, plan: null, skipped: "local optimizer disabled (EMS_LOCAL_OPTIMIZER=off)" };
    // Fallback rule: stand down while an external plan is in force.
    const active = await db
      .select({ id: emsPlans.id, source: emsPlans.source, createdAt: emsPlans.createdAt })
      .from(emsPlans)
      .where(
        and(
          eq(emsPlans.meterId, meterId),
          eq(emsPlans.status, "active"),
          lte(emsPlans.validFrom, now),
          gte(emsPlans.validTo, now),
        ),
      );
    const maxAge = externalPlanMaxAgeMs();
    if (active.some((p) => isFreshExternal(p, now.getTime(), maxAge))) {
      return { meterId, plan: null, skipped: "external plan in force — local optimizer is fallback only" };
    }
  }

  // Capacity comes from the MEASURED nameplate in battery_health, not from a
  // second copy here: one capacity figure, so a plan cannot be built against a
  // number that disagrees with the one the health page reports.
  const healthRows = await db
    .select({ nameplateKwh: batteryHealth.nameplateKwh, sohPct: batteryHealth.sohPct })
    .from(batteryHealth)
    .where(eq(batteryHealth.meterId, meterId))
    .limit(1);
  const nameplate = healthRows[0]?.nameplateKwh ?? null;
  if (nameplate === null) return { meterId, plan: null, skipped: "battery nameplate not set" };
  // Plan against what the battery can hold NOW, not what it could when new. A
  // plan built on nameplate after years of fade schedules energy that is not
  // there, and the shortfall shows up as a missed discharge at the one hour
  // the plan existed to cover.
  const soh = healthRows[0]?.sohPct ?? null;
  const capacityKwh = soh !== null ? nameplate * Math.min(1, soh / 100) : nameplate;

  const tariff = await tariffFor(meter.siteId, meter.orgId);
  if (!tariff) return { meterId, plan: null, skipped: "no tariff applies to this device" };

  const fromMs = Math.floor(now.getTime() / 3_600_000) * 3_600_000;
  const toMs = fromMs + HORIZON_H * 3_600_000;

  const periods = await db
    .select()
    .from(tariffPeriods)
    .where(eq(tariffPeriods.tariffId, tariff.id))
    .orderBy(asc(tariffPeriods.id));
  const prices = await db
    .select()
    .from(tariffPrices)
    .where(
      and(
        eq(tariffPrices.tariffId, tariff.id),
        gte(tariffPrices.hourStart, new Date(fromMs)),
        lte(tariffPrices.hourStart, new Date(toMs)),
      ),
    );

  const curve = priceCurve(
    fromMs,
    toMs,
    periods.map((p) => ({
      dayOfWeekMask: p.dayOfWeekMask,
      startMin: p.startMin,
      endMin: p.endMin,
      importPrice: p.importPrice,
      exportPrice: p.exportPrice,
    })),
    prices.map((p) => ({
      hourStartMs: p.hourStart.getTime(),
      importPrice: p.importPrice,
      exportPrice: p.exportPrice,
    })),
    tariff.timezone,
  );

  const limits: BatteryLimits = {
    capacityKwh,
    maxPowerKw: econ.maxPowerKw,
    roundTripEfficiency: econ.roundTripEfficiency,
    minSocPct: econ.minSocPct,
    maxSocPct: econ.maxSocPct,
    cycleCost: econ.cycleCost,
  };
  const plan = planArbitrage(curve, limits);
  if (dryRun) return { meterId, plan, skipped: plan.reason };
  if (plan.setpoints.length === 0) return { meterId, plan, skipped: plan.reason };

  // Supersede our own previous plan rather than stacking: the controller takes
  // the newest active plan, and leaving the old ones active makes "which plan
  // is running" a question about row ordering.
  await db
    .update(emsPlans)
    .set({ status: "superseded" })
    .where(and(eq(emsPlans.meterId, meterId), eq(emsPlans.source, "tariff-optimizer"), eq(emsPlans.status, "active")));

  await db.insert(emsPlans).values({
    meterId,
    // ems_plans.org_id is NOT NULL and unsigned, so a device with no org gets
    // 0: owned by no tenant and visible to superadmins only, like the device
    // itself. The -1 that org-scoped reads use to match nothing would be
    // rejected by the column.
    orgId: meter.orgId ?? 0,
    source: "tariff-optimizer",
    validFrom: new Date(fromMs),
    validTo: new Date(toMs),
    setpoints: plan.setpoints,
    // The plan carries the SoC limits it was built against, so the controller
    // enforces the same envelope the arithmetic assumed instead of a wider one
    // configured elsewhere.
    minSoc: econ.minSocPct,
    maxSoc: econ.maxSocPct,
    status: "active",
  });
  return { meterId, plan, skipped: null };
}

/** Batteries read per query while sweeping. */
const SWEEP_PAGE = 100;

export async function optimizerSweep(now = new Date()): Promise<{ planned: number; skipped: number }> {
  const db = getDb();
  let planned = 0;
  let skipped = 0;
  // Every enabled battery, a page at a time in id order. The first version
  // read one unordered page of 100 and stopped, so on a larger fleet the same
  // hundred were planned every sweep and the rest never were.
  let after = 0;
  for (;;) {
    const rows = await db
      .select({ meterId: batteryEconomics.meterId })
      .from(batteryEconomics)
      .where(and(eq(batteryEconomics.optimizerEnabled, true), gt(batteryEconomics.meterId, after)))
      .orderBy(asc(batteryEconomics.meterId))
      .limit(SWEEP_PAGE);
    for (const r of rows) {
      try {
        const out = await optimizeBattery(r.meterId, false, now);
        if (out.skipped === null) planned++;
        else {
          skipped++;
          console.log(`[optimizer] meter ${r.meterId}: ${out.skipped}`);
        }
      } catch (e) {
        skipped++;
        console.warn(`[optimizer] meter ${r.meterId} failed:`, e instanceof Error ? e.message : e);
      }
    }
    if (rows.length < SWEEP_PAGE) break;
    after = rows[rows.length - 1].meterId;
  }
  return { planned, skipped };
}

let timer: NodeJS.Timeout | null = null;
export function startOptimizerLoop(): void {
  if (timer) return;
  timer = setInterval(() => {
    // Leased: two replicas would each write a plan, and the controller would
    // execute whichever landed last — a coin toss between two plans built from
    // the same prices is still a coin toss.
    withLease("tariff-optimizer", () => optimizerSweep(), 2 * SWEEP_MS).catch((e) =>
      console.warn("[optimizer] sweep failed:", e instanceof Error ? e.message : e),
    );
  }, SWEEP_MS);
  timer.unref?.();
  console.log("[optimizer] tariff planner started");
}
