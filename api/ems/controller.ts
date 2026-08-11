// v8/D1: automatic EMS controller — BESS charge/discharge scheduling and
// automatic peak shaving, built on the C12 active-control mechanism.
//
// Every decision goes through executeAndLog (userId null = system), so the
// C12 interlock (device_profiles.controllable whitelist + range check) and
// the commands/audit trail apply to automatic commands exactly as they do to
// manual ones.
//
// Schedules:
//  - Each tick, enabled schedules are evaluated against the current LOCAL time
//    of the meter's effective site (meters.siteId ?? gateways.siteId →
//    sites.timezone, default UTC — IANA zones via Intl, DST-correct).
//  - A schedule is due when its weekday bit is set and local minutes fall in
//    [startMin, endMin); windows with startMin > endMin wrap midnight.
//  - When several schedules on one meter are due, the lowest id wins
//    (deterministic; document conflicts by naming).
//  - A due schedule writes its setpoint to the BESS control register:
//      discharge → +targetKw, charge → ±targetKw (negative only when the
//      register's range allows it), idle → 0 kW. targetKw null = register max.
//  - SOC guard (targetSoc set): discharge skipped at/below targetSoc, charge
//    skipped at/above — the last setpoint stays in place.
//  - Schedules do NOT auto-reset the BESS when the window ends — add an
//    explicit "idle" schedule to zero the setpoint (documented behavior).
//
// Peak shaving:
//  - Reads the source meter's latest import activePowerKw (telemetry store).
//  - import > thresholdKw → discharge the BESS at
//    min(import − threshold, maxDischargeKw, register max).
//  - import < thresholdKw − hysteresisKw → stop (setpoint 0).
//  - While active the setpoint is only re-sent when it moved by
//    ≥ max(1 kW, 10 % of maxDischargeKw) — telemetry wiggle must not spam the bus.
//
// EMS plans (v9 Contract A — externally pushed, e.g. by the VoltTrade
// optimizer): priority per meter per tick is peak-shaving > plan > schedules:
//  - Peak shaving evaluates first; a BESS with a firing/active peak config
//    this tick skips plan and schedule evaluation entirely.
//  - Else the meter's active plan (valid_from ≤ now ≤ valid_to, latest
//    created_at wins) drives the setpoint as a step function: kw of the last
//    setpoint with ts ≤ now. kw > 0 = discharge, kw < 0 = charge (negative
//    only when the register's range allows), 0 = idle. Executed through the
//    same executeAndLog path (userId null) as schedules; the command's result
//    string is prefixed `plan:<source>` for audit attribution. Plans carry no
//    targetSoc, so the schedule SOC guard (only active when targetSoc is set)
//    is vacuous for them — the C12 interlock/range checks apply identically.
//  - A meter that executed a plan setpoint skips schedule evaluation.
//  - Plans fully past valid_to are lazily marked expired by one bounded sweep
//    per tick (LIMIT 500) — never a per-meter scan.
//
// Robustness: the tick and every single evaluation are wrapped in try/catch —
// the loop never throws. Idempotency: identical (meter, key, value) commands
// are suppressed for IDEMPOTENCY_MS (5 min) so steady-state schedules don't
// rewrite the same register every tick.
import { asc, eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { emsPeakShaving, emsSchedules, gateways, meters, sites } from "@db/schema";
import type { EmsPeakShaving, EmsSchedule, Meter } from "@db/schema";
import { ControlError, controllableForModel, executeAndLog } from "../control/execute";
import type { ControllableDef, ControllableMap } from "../control/execute";
import { getTelemetryStore } from "../telemetry";
import { tzOffsetMs } from "../lib/tz";

const TICK_S = parseInt(process.env.EMS_TICK_S || "30", 10);
export const EMS_IDEMPOTENCY_MS = 5 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;

export function startEmsLoop(): void {
  if (timer) return;
  if (TICK_S <= 0) {
    console.log("[ems] disabled via EMS_TICK_S<=0"); // v8/D6: probe/secondary-replica switch
    return;
  }
  timer = setInterval(() => {
    emsTick().catch((err) => console.error("[ems] tick failed:", err instanceof Error ? err.message : err));
  }, TICK_S * 1000);
  timer.unref?.();
  // Boot tick: apply due schedules / peak shaving immediately after start.
  emsTick().catch((err) => console.error("[ems] boot tick failed:", err instanceof Error ? err.message : err));
  console.log(`[ems] controller started (tick ${TICK_S}s)`);
}

// ─── Setpoint key selection ─────────────────────────────────────────────────
// BESS profiles declare writable registers in device_profiles.controllable.
// Preferred keys per mode; fall back to the first declared key so any
// single-register BESS still works.
const KEY_PREF: Record<"charge" | "discharge" | "idle", string[]> = {
  discharge: ["dischargePowerKw", "chargeDischargePowerKw", "activePowerKw"],
  charge: ["chargePowerKw", "chargeDischargePowerKw", "activePowerKw"],
  idle: ["dischargePowerKw", "chargeDischargePowerKw", "activePowerKw"],
};

export function pickSetpointKey(map: ControllableMap, mode: "charge" | "discharge" | "idle"): { key: string; def: ControllableDef } | null {
  for (const k of KEY_PREF[mode]) {
    if (map[k]) return { key: k, def: map[k] };
  }
  const first = Object.entries(map)[0];
  return first ? { key: first[0], def: first[1] } : null;
}

/** Setpoint value for a mode: idle → 0; charge → −t when the register is bipolar, else +t (dedicated charge register). */
export function setpointValue(mode: "charge" | "discharge" | "idle", def: ControllableDef, targetKw: number | null): number {
  if (mode === "idle") return 0;
  const t = targetKw ?? def.max;
  return mode === "charge" && def.min < 0 ? -t : t;
}

// ─── Idempotency + peak-shaving state ────────────────────────────────────────
const lastCmd = new Map<string, { value: number; at: number }>(); // "<meterId>:<key>" → last sent
const peakState = new Map<number, { active: boolean; lastSent: number | null }>(); // config id → state

async function send(meter: Meter, key: string, value: number, why: string, resultPrefix?: string): Promise<void> {
  const dedupKey = `${meter.id}:${key}`;
  const last = lastCmd.get(dedupKey);
  if (last && last.value === value && Date.now() - last.at < EMS_IDEMPOTENCY_MS) return;
  try {
    const res = await executeAndLog(meter, key, value, null); // system command
    lastCmd.set(dedupKey, { value, at: Date.now() });
    if (resultPrefix) await tagLastCommand(meter, key, resultPrefix);
    console.log(`[ems] ${why}: ${meter.name} ${key}=${value} → ${res.status} (${res.detail})`);
  } catch (err) {
    // ControlError rows are already logged as rejected commands by executeAndLog;
    // remember the attempt so a permanently-rejected setpoint isn't retried every tick.
    if (err instanceof ControlError) lastCmd.set(dedupKey, { value, at: Date.now() });
    console.error(`[ems] ${why}: ${meter.name} ${key}=${value} failed:`, err instanceof Error ? err.message : err);
  }
}

/** Prefix the result of the just-logged command (v9: `plan:<source>` audit attribution). */
async function tagLastCommand(meter: Meter, key: string, prefix: string): Promise<void> {
  try {
    await getDb().execute(
      sql`update commands set result = concat(${prefix}, ' ', result) where id = (select max(id) from (select id from commands where meter_id = ${meter.id} and control_key = ${key} and user_id is null) t)`,
    );
  } catch (err) {
    console.error(`[ems] result tagging failed for ${meter.name} ${key}:`, err instanceof Error ? err.message : err);
  }
}

// ─── Per-tick helpers ────────────────────────────────────────────────────────
async function loadMeters(ids: number[]): Promise<Map<number, Meter>> {
  const map = new Map<number, Meter>();
  if (ids.length === 0) return map;
  const rows = await getDb().select().from(meters).where(inArray(meters.id, [...new Set(ids)]));
  for (const r of rows) map.set(r.id, r);
  return map;
}

/** Effective site timezone for a meter: meters.siteId ?? gateways.siteId → sites.timezone (default UTC). */
async function meterTimezone(meter: Meter): Promise<string> {
  const db = getDb();
  let siteId = meter.siteId;
  if (siteId == null) {
    const gw = await db.select({ siteId: gateways.siteId }).from(gateways).where(eq(gateways.id, meter.gatewayId)).limit(1);
    siteId = gw[0]?.siteId ?? null;
  }
  if (siteId == null) return "UTC";
  const s = await db.select({ timezone: sites.timezone }).from(sites).where(eq(sites.id, siteId)).limit(1);
  return s[0]?.timezone ?? "UTC";
}

/** Local weekday (0=Sunday) and minutes-from-midnight for an instant in a zone. */
export function localClock(tz: string, now: Date): { dow: number; min: number } {
  const local = new Date(now.getTime() + tzOffsetMs(tz, now));
  return { dow: local.getUTCDay(), min: local.getUTCHours() * 60 + local.getUTCMinutes() };
}

export function scheduleDue(s: EmsSchedule, dow: number, min: number): boolean {
  if (((s.dayOfWeekMask >> dow) & 1) === 0) return false;
  if (s.startMin === s.endMin) return true; // 00:00–00:00 = all day
  if (s.startMin < s.endMin) return min >= s.startMin && min < s.endMin;
  return min >= s.startMin || min < s.endMin; // wraps midnight
}

async function evalSchedules(now: Date, skip: Set<number> = new Set()): Promise<void> {
  const db = getDb();
  const schedules = await db.select().from(emsSchedules).where(eq(emsSchedules.enabled, true)).orderBy(asc(emsSchedules.id));
  if (schedules.length === 0) return;
  const meterMap = await loadMeters(schedules.map((s) => s.meterId));
  const tzCache = new Map<number, string>();
  const wlCache = new Map<string, ControllableMap>();
  const fired = new Set<number>(); // one winning schedule per meter per tick

  for (const s of schedules) {
    if (fired.has(s.meterId)) continue; // lowest id already won this tick
    if (skip.has(s.meterId)) {
      // v9: a higher-priority strategy (peak shaving / active plan) already
      // drove this meter this tick — schedules stand down.
      fired.add(s.meterId);
      continue;
    }
    try {
      const meter = meterMap.get(s.meterId);
      if (!meter) continue;
      let tz = tzCache.get(s.meterId);
      if (tz === undefined) {
        tz = await meterTimezone(meter);
        tzCache.set(s.meterId, tz);
      }
      const { dow, min } = localClock(tz, now);
      if (!scheduleDue(s, dow, min)) continue;
      let wl = wlCache.get(meter.model);
      if (!wl) {
        wl = await controllableForModel(meter.model);
        wlCache.set(meter.model, wl);
      }
      const sel = pickSetpointKey(wl, s.mode);
      if (!sel) {
        console.warn(`[ems] schedule ${s.id}: model ${meter.model} has no controllable registers — skipped`);
        fired.add(s.meterId);
        continue;
      }
      // SOC guard (uses the BESS's own latest telemetry).
      if (s.targetSoc != null) {
        const latest = await getTelemetryStore().latest(s.meterId);
        const soc = latest?.values.socPercent;
        if (soc != null && ((s.mode === "discharge" && soc <= s.targetSoc) || (s.mode === "charge" && soc >= s.targetSoc))) {
          fired.add(s.meterId);
          continue; // guard active — leave the previous setpoint untouched
        }
      }
      const value = setpointValue(s.mode, sel.def, s.targetKw);
      await send(meter, sel.key, value, `schedule "${s.name}" (${s.mode})`);
      fired.add(s.meterId);
    } catch (err) {
      console.error(`[ems] schedule ${s.id} evaluation failed:`, err instanceof Error ? err.message : err);
    }
  }
}

/** Returns the BESS meter ids peak shaving drove this tick (v9 priority gate). */
async function evalPeakShaving(): Promise<Set<number>> {
  const drove = new Set<number>();
  const db = getDb();
  const configs = await db.select().from(emsPeakShaving).where(eq(emsPeakShaving.enabled, true));
  if (configs.length === 0) return drove;
  const meterMap = await loadMeters(configs.flatMap((c) => [c.sourceMeterId, c.bessMeterId]));
  const wlCache = new Map<string, ControllableMap>();
  const store = getTelemetryStore();

  for (const c of configs) {
    try {
      const bess = meterMap.get(c.bessMeterId);
      if (!bess) continue;
      const latest = await store.latest(c.sourceMeterId);
      const importKw = latest?.values.activePowerKw;
      if (importKw == null) continue; // no telemetry yet — nothing to decide on
      let st = peakState.get(c.id) ?? { active: false, lastSent: null };

      if (!st.active) {
        if (importKw <= c.thresholdKw) {
          peakState.set(c.id, st);
          continue;
        }
        let wl = wlCache.get(bess.model);
        if (!wl) {
          wl = await controllableForModel(bess.model);
          wlCache.set(bess.model, wl);
        }
        const sel = pickSetpointKey(wl, "discharge");
        if (!sel) {
          console.warn(`[ems] peak-shaving ${c.id}: model ${bess.model} has no controllable registers — skipped`);
          peakState.set(c.id, st);
          continue;
        }
        const power = Math.min(importKw - c.thresholdKw, c.maxDischargeKw, sel.def.max);
        if (power <= 0) {
          peakState.set(c.id, st);
          continue;
        }
        await send(bess, sel.key, power, `peak-shaving #${c.id} (import ${importKw.toFixed(2)} kW > ${c.thresholdKw} kW)`);
        st = { active: true, lastSent: power };
        peakState.set(c.id, st);
        drove.add(c.bessMeterId);
        continue;
      }

      // Active: stop below threshold − hysteresis.
      if (importKw < c.thresholdKw - c.hysteresisKw) {
        let wl = wlCache.get(bess.model);
        if (!wl) {
          wl = await controllableForModel(bess.model);
          wlCache.set(bess.model, wl);
        }
        const sel = pickSetpointKey(wl, "discharge");
        if (sel) await send(bess, sel.key, 0, `peak-shaving #${c.id} stop (import ${importKw.toFixed(2)} kW)`);
        peakState.set(c.id, { active: false, lastSent: null });
        drove.add(c.bessMeterId); // the stop command owns this tick
        continue;
      }
      // Still above threshold: re-trim only on a meaningful change.
      let wl = wlCache.get(bess.model);
      if (!wl) {
        wl = await controllableForModel(bess.model);
        wlCache.set(bess.model, wl);
      }
      const sel = pickSetpointKey(wl, "discharge");
      if (!sel) continue;
      const power = Math.min(Math.max(importKw - c.thresholdKw, 0), c.maxDischargeKw, sel.def.max);
      const minDelta = Math.max(1, 0.1 * c.maxDischargeKw);
      if (st.lastSent == null || Math.abs(power - st.lastSent) >= minDelta) {
        await send(bess, sel.key, power, `peak-shaving #${c.id} re-trim (import ${importKw.toFixed(2)} kW)`);
        st.lastSent = power;
        peakState.set(c.id, st);
      }
      drove.add(c.bessMeterId); // still riding a peak event — hold plan/schedules
    } catch (err) {
      console.error(`[ems] peak-shaving ${c.id} evaluation failed:`, err instanceof Error ? err.message : err);
    }
  }
  return drove;
}

// ─── EMS plans (v9 Contract A) ───────────────────────────────────────────────
const PLAN_EXPIRE_SWEEP_LIMIT = 500; // bounded lazy sweep per tick
const utcStr = (d: Date) => d.toISOString().slice(0, 19).replace("T", " ");

interface PlanTickRow {
  id: number;
  meterId: number;
  source: string;
  setpoints: Array<{ ts: string; kw: number }> | string;
}

/**
 * Execute due plan setpoints for meters not already driven by peak shaving.
 * Returns the meter ids a plan drove this tick (schedules stand down for them).
 */
async function evalPlans(now: Date, skip: Set<number>): Promise<Set<number>> {
  const fired = new Set<number>();
  const db = getDb();
  const nowStr = utcStr(now);
  // Lazy expiry: one bounded sweep per tick — plans fully past valid_to.
  await db.execute(sql`update ems_plans set status = 'expired' where status = 'active' and valid_to < ${nowStr} limit ${PLAN_EXPIRE_SWEEP_LIMIT}`);
  // Active plans covering now; latest created_at per meter wins (overlap is
  // already prevented by the PUT supersede semantics, this is belt & braces).
  const res = await db.execute(
    sql`select id, meter_id as meterId, source, setpoints from ems_plans where status = 'active' and valid_from <= ${nowStr} and valid_to >= ${nowStr} order by meter_id, created_at desc, id desc`,
  );
  const plans = res[0] as unknown as PlanTickRow[];
  if (plans.length === 0) return fired;
  const byMeter = new Map<number, PlanTickRow>();
  for (const p of plans) {
    if (!byMeter.has(p.meterId)) byMeter.set(p.meterId, p);
  }
  const meterMap = await loadMeters([...byMeter.keys()]);
  const wlCache = new Map<string, ControllableMap>();

  for (const [meterId, plan] of byMeter) {
    if (skip.has(meterId)) continue;
    try {
      const meter = meterMap.get(meterId);
      if (!meter) continue;
      const sps = (typeof plan.setpoints === "string" ? JSON.parse(plan.setpoints) : plan.setpoints) as Array<{ ts: string; kw: number }>;
      // Step function: kw of the last setpoint with ts ≤ now.
      let kw: number | null = null;
      for (const sp of sps) {
        if (Date.parse(sp.ts) <= now.getTime()) kw = sp.kw;
        else break;
      }
      if (kw == null) continue; // no setpoint due yet — leave the register alone
      const mode = kw > 0 ? ("discharge" as const) : kw < 0 ? ("charge" as const) : ("idle" as const);
      let wl = wlCache.get(meter.model);
      if (!wl) {
        wl = await controllableForModel(meter.model);
        wlCache.set(meter.model, wl);
      }
      const sel = pickSetpointKey(wl, mode);
      if (!sel) {
        console.warn(`[ems] plan ${plan.id}: model ${meter.model} has no controllable registers — skipped`);
        fired.add(meterId);
        continue;
      }
      // No targetSoc on plans: the schedule SOC guard (active only when
      // targetSoc is set) does not apply; C12 interlock/range checks do.
      const value = setpointValue(mode, sel.def, Math.abs(kw));
      await send(meter, sel.key, value, `plan #${plan.id} (${plan.source}, ${kw} kW)`, `plan:${plan.source}`);
      fired.add(meterId);
    } catch (err) {
      console.error(`[ems] plan ${plan.id} evaluation failed:`, err instanceof Error ? err.message : err);
    }
  }
  return fired;
}

/** One controller iteration — exported for tests. Never throws. */
export async function emsTick(): Promise<void> {
  try {
    const now = new Date();
    // v9 priority: peak shaving > active plan > schedules.
    const peakDrove = await evalPeakShaving();
    const planDrove = await evalPlans(now, peakDrove);
    await evalSchedules(now, new Set([...peakDrove, ...planDrove]));
  } catch (err) {
    console.error("[ems] tick error:", err instanceof Error ? err.message : err);
  }
}
