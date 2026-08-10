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
// Robustness: the tick and every single evaluation are wrapped in try/catch —
// the loop never throws. Idempotency: identical (meter, key, value) commands
// are suppressed for IDEMPOTENCY_MS (5 min) so steady-state schedules don't
// rewrite the same register every tick.
import { asc, eq, inArray } from "drizzle-orm";
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

async function send(meter: Meter, key: string, value: number, why: string): Promise<void> {
  const dedupKey = `${meter.id}:${key}`;
  const last = lastCmd.get(dedupKey);
  if (last && last.value === value && Date.now() - last.at < EMS_IDEMPOTENCY_MS) return;
  try {
    const res = await executeAndLog(meter, key, value, null); // system command
    lastCmd.set(dedupKey, { value, at: Date.now() });
    console.log(`[ems] ${why}: ${meter.name} ${key}=${value} → ${res.status} (${res.detail})`);
  } catch (err) {
    // ControlError rows are already logged as rejected commands by executeAndLog;
    // remember the attempt so a permanently-rejected setpoint isn't retried every tick.
    if (err instanceof ControlError) lastCmd.set(dedupKey, { value, at: Date.now() });
    console.error(`[ems] ${why}: ${meter.name} ${key}=${value} failed:`, err instanceof Error ? err.message : err);
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

async function evalSchedules(now: Date): Promise<void> {
  const db = getDb();
  const schedules = await db.select().from(emsSchedules).where(eq(emsSchedules.enabled, true)).orderBy(asc(emsSchedules.id));
  if (schedules.length === 0) return;
  const meterMap = await loadMeters(schedules.map((s) => s.meterId));
  const tzCache = new Map<number, string>();
  const wlCache = new Map<string, ControllableMap>();
  const fired = new Set<number>(); // one winning schedule per meter per tick

  for (const s of schedules) {
    if (fired.has(s.meterId)) continue; // lowest id already won this tick
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

async function evalPeakShaving(): Promise<void> {
  const db = getDb();
  const configs = await db.select().from(emsPeakShaving).where(eq(emsPeakShaving.enabled, true));
  if (configs.length === 0) return;
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
    } catch (err) {
      console.error(`[ems] peak-shaving ${c.id} evaluation failed:`, err instanceof Error ? err.message : err);
    }
  }
}

/** One controller iteration — exported for tests. Never throws. */
export async function emsTick(): Promise<void> {
  try {
    const now = new Date();
    await evalSchedules(now);
    await evalPeakShaving();
  } catch (err) {
    console.error("[ems] tick error:", err instanceof Error ? err.message : err);
  }
}
