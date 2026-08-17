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
//    skipped at/above — the last setpoint stays in place. audit wave 6: the
//    guard FAILS CLOSED — SoC is read via freshForControl (age-bounded), and
//    a missing/stale/unknown SoC blocks the schedule's charge/discharge.
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
//  - audit wave 6, CONSERVATIVE SAFETY OVERRIDE (deliberate, documented):
//    peak shaving has no own SoC config, but if an ACTIVE ems_plan with
//    configured SoC limits exists for the same bessMeterId, those limits also
//    bind the peak-shaving DISCHARGE (socGuardDecision, fail-closed on
//    stale/missing SoC). Blocked → don't start; an already-active event is
//    cut to idle 0 kW (same as a stop). This does NOT change the
//    peak > plan > schedule priority — it is a top-down safety clamp,
//    analogous to EMS STOP, applied before any peak decision.
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
//    string is prefixed `plan:<source>` for audit attribution. audit wave 6:
//    plans MAY carry minSoc/maxSoc limits (migration 0020) — when configured,
//    the fail-closed SoC guard binds plan setpoints and a blocked setpoint is
//    replaced by an explicit idle 0 kW (deliberate strengthening, see
//    evalPlans). Plans without limits behave exactly as before.
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
import type { Meter } from "@db/schema";
import { ControlError, controllableForModel, executeAndLog } from "../control/execute";
import type { ControllableMap } from "../control/execute";
import { getTelemetryStore } from "../telemetry";
import { guarded } from "../lib/error-reporting";
import {
  kwToMode,
  peakHoldPower,
  peakMinMoveKw,
  peakRetrimDue,
  peakStartPower,
  peakStopDue,
  pickSetpointKey,
  planKwAt,
  scheduleDue,
  setpointValue,
  socGuardDecision,
  localClock,
} from "./decide";

// v10/P1-9: pure decision logic lives in ./decide (extracted unchanged for
// unit tests); re-export the helpers that were already public from here.
export { localClock, pickSetpointKey, scheduleDue, setpointValue } from "./decide";

const TICK_S = parseInt(process.env.EMS_TICK_S || "30", 10);
export const EMS_IDEMPOTENCY_MS = 5 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;

export function startEmsLoop(): void {
  if (timer) return;
  if (TICK_S <= 0) {
    console.log("[ems] disabled via EMS_TICK_S<=0"); // v8/D6: probe/secondary-replica switch
    return;
  }
  // Audit wave 4: guarded() reports a tick failure (Sentry/log) and never
  // rethrows — same loop-survives behavior as the previous .catch(console).
  const tick = guarded("ems-tick", emsTick);
  timer = setInterval(() => {
    void tick();
  }, TICK_S * 1000);
  timer.unref?.();
  // Boot tick: apply due schedules / peak shaving immediately after start.
  void tick();
  console.log(`[ems] controller started (tick ${TICK_S}s)`);
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
      // SOC guard (fail-closed, audit wave 6 — uses the BESS's own telemetry
      // via freshForControl). targetSoc maps to {minSoc,maxSoc} = targetSoc
      // (legacy semantics). A STALE or missing row → soc=null → BLOCKED: an
      // unknown battery state must never drive a (dis)charge.
      if (s.targetSoc != null) {
        const ft = await getTelemetryStore().freshForControl(s.meterId);
        const soc = ft.fresh ? (ft.row?.values.socPercent ?? null) : null;
        const guard = socGuardDecision(s.mode, soc, { minSoc: s.targetSoc, maxSoc: s.targetSoc });
        if (guard.blocked) {
          console.warn(`[ems] schedule ${s.id} "${s.name}" blocked by SoC guard: ${guard.reason}`);
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

/**
 * audit wave 6: active plans (valid_from ≤ now ≤ valid_to, latest created_at
 * per meter wins — same rule as evalPlans) that carry SoC limits, keyed by
 * meter. Used by evalPeakShaving as the conservative safety override.
 */
async function activePlanSocLimits(
  meterIds: number[],
  nowStr: string,
): Promise<Map<number, { minSoc: number | null; maxSoc: number | null }>> {
  const map = new Map<number, { minSoc: number | null; maxSoc: number | null }>();
  const ids = [...new Set(meterIds)];
  if (ids.length === 0) return map;
  const res = await getDb().execute(
    sql`select meter_id as meterId, min_soc as minSoc, max_soc as maxSoc from ems_plans where status = 'active' and valid_from <= ${nowStr} and valid_to >= ${nowStr} and meter_id in (${sql.join(ids.map((id) => sql`${id}`), sql`, `)}) and (min_soc is not null or max_soc is not null) order by meter_id, created_at desc, id desc`,
  );
  for (const r of res[0] as unknown as Array<{ meterId: number; minSoc: number | null; maxSoc: number | null }>) {
    if (map.has(r.meterId)) continue; // latest created_at already won (order above)
    if (r.minSoc == null && r.maxSoc == null) continue; // belt & braces with the WHERE clause
    map.set(r.meterId, { minSoc: r.minSoc ?? null, maxSoc: r.maxSoc ?? null });
  }
  return map;
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
  // audit wave 6: SoC limits of any ACTIVE plan on a BESS bind peak-shaving
  // discharge for that BESS (see the header comment — safety override).
  const planLimits = await activePlanSocLimits(
    configs.map((c) => c.bessMeterId),
    utcStr(new Date()),
  );

  for (const c of configs) {
    try {
      const bess = meterMap.get(c.bessMeterId);
      if (!bess) continue;

      // Safety override FIRST — it binds even when source-meter telemetry is
      // missing: an active event must still be cut to idle on a SoC violation.
      const limits = planLimits.get(c.bessMeterId);
      if (limits) {
        const ft = await store.freshForControl(c.bessMeterId);
        const soc = ft.fresh ? (ft.row?.values.socPercent ?? null) : null;
        const guard = socGuardDecision("discharge", soc, limits);
        if (guard.blocked) {
          const st = peakState.get(c.id) ?? { active: false, lastSent: null };
          if (st.active) {
            // Cut the running event to idle 0 kW (deliberate strengthening —
            // same stop semantics as dropping below threshold − hysteresis).
            let wl = wlCache.get(bess.model);
            if (!wl) {
              wl = await controllableForModel(bess.model);
              wlCache.set(bess.model, wl);
            }
            const sel = pickSetpointKey(wl, "discharge");
            if (sel) await send(bess, sel.key, 0, `peak-shaving #${c.id} BLOCKED by active plan SoC limits: ${guard.reason} → idle 0 kW`);
            peakState.set(c.id, { active: false, lastSent: null });
            drove.add(c.bessMeterId); // the cut-to-idle command owns this tick
          } else {
            // Don't start: leave the meter to plan/schedule evaluation (the
            // plan guard applies there too, so this cannot fail open).
            peakState.set(c.id, st);
            console.warn(`[ems] peak-shaving #${c.id} start blocked by active plan SoC limits: ${guard.reason}`);
          }
          continue;
        }
      }

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
        const power = peakStartPower(importKw, c.thresholdKw, c.maxDischargeKw, sel.def.max);
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
      if (peakStopDue(importKw, c.thresholdKw, c.hysteresisKw)) {
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
      const power = peakHoldPower(importKw, c.thresholdKw, c.maxDischargeKw, sel.def.max);
      const minDelta = peakMinMoveKw(c.maxDischargeKw);
      if (peakRetrimDue(power, st.lastSent, minDelta)) {
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
  // audit wave 6: optional SoC limits (migration 0020); both null = no guard
  // (legacy plans — behavior unchanged).
  minSoc: number | null;
  maxSoc: number | null;
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
    sql`select id, meter_id as meterId, source, setpoints, min_soc as minSoc, max_soc as maxSoc from ems_plans where status = 'active' and valid_from <= ${nowStr} and valid_to >= ${nowStr} order by meter_id, created_at desc, id desc`,
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
      const kw = planKwAt(sps, now.getTime());
      if (kw == null) continue; // no setpoint due yet — leave the register alone
      const mode = kwToMode(kw);
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
      // audit wave 6: plans MAY carry SoC limits (min_soc/max_soc, migration
      // 0020). When at least one is configured the fail-closed guard applies,
      // with the SoC read via freshForControl (stale/missing → soc=null →
      // BLOCKED). DELIBERATE STRENGTHENING (documented, per SPEC): a blocked
      // plan setpoint is replaced by an explicit idle 0 kW command instead of
      // leaving the previous setpoint in place — the previous setpoint may be
      // exactly the dangerous (dis)charge. The reason is logged and written
      // into the command audit trail. Plans without limits keep the legacy
      // behavior (guard vacuous; C12 interlock/range checks unchanged).
      if (plan.minSoc != null || plan.maxSoc != null) {
        const ft = await getTelemetryStore().freshForControl(meterId);
        const soc = ft.fresh ? (ft.row?.values.socPercent ?? null) : null;
        const guard = socGuardDecision(mode, soc, { minSoc: plan.minSoc ?? null, maxSoc: plan.maxSoc ?? null });
        if (guard.blocked) {
          await send(
            meter,
            sel.key,
            0,
            `plan #${plan.id} (${plan.source}) BLOCKED by SoC guard: ${guard.reason} → idle 0 kW`,
            `plan:${plan.source}`,
          );
          fired.add(meterId); // the plan still owns this tick — schedules stand down
          continue;
        }
      }
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
