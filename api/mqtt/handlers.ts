// Message handlers: normalize G30 JSON uplinks and C30 transparent Modbus frames
// into telemetry rows, and evaluate alarm rules.
import { eq, and } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { meters, alarmRules, alarms, deviceProfiles } from "@db/schema";
import { getTelemetryWriter } from "../telemetry";
import { markMeterSeen } from "./liveness";
import type { MetricKey, RegisterDef } from "@contracts/modbus";
import { DEFAULT_REGISTER_MAPS, DEFAULT_METER_PHASES } from "@contracts/modbus";
import { parseResponse, decodeRegisters, registerSpan } from "../modbus";
import type { Gateway, Meter } from "@db/schema";

// ─── Register maps (DB-backed, seeded from defaults) ────────────────────────
let profileCache: { at: number; maps: Map<string, RegisterDef[]> } | null = null;

export async function getRegisterMaps(): Promise<Map<string, RegisterDef[]>> {
  if (profileCache && Date.now() - profileCache.at < 30_000) return profileCache.maps;
  const db = getDb();
  let rows = await db.select().from(deviceProfiles);
  if (rows.length === 0) {
    // Seed defaults on first use
    for (const model of Object.keys(DEFAULT_REGISTER_MAPS) as Array<keyof typeof DEFAULT_REGISTER_MAPS>) {
      await db.insert(deviceProfiles).values({
        model,
        label: `${model} default map (verify vs vendor protocol doc)`,
        registerMap: DEFAULT_REGISTER_MAPS[model],
      });
    }
    rows = await db.select().from(deviceProfiles);
  }
  const maps = new Map<string, RegisterDef[]>();
  for (const r of rows) maps.set(r.model, r.registerMap as RegisterDef[]);
  profileCache = { at: Date.now(), maps };
  return maps;
}

export function invalidateProfileCache() {
  profileCache = null;
}

// ─── Auto-provisioning ───────────────────────────────────────────────────────
// Meters are cached in memory — at fleet scale every MQTT message would
// otherwise cost a metadata lookup, and the steady-state meter set is small
// enough (tens of thousands) to hold in RAM.
export const meterCache = new Map<string, Meter>();

export async function ensureMeter(
  gateway: Gateway,
  slaveAddress: number,
  modelGuess?: string,
): Promise<Meter> {
  const cacheKey = `${gateway.id}:${slaveAddress}`;
  const cached = meterCache.get(cacheKey);
  if (cached) return cached;

  const db = getDb();
  const existing = await db
    .select()
    .from(meters)
    .where(and(eq(meters.gatewayId, gateway.id), eq(meters.modbusAddress, slaveAddress)))
    .limit(1);
  if (existing[0]) {
    meterCache.set(cacheKey, existing[0]);
    return existing[0];
  }

  const model = (modelGuess === "SEM2250" || modelGuess === "SEM3250" || modelGuess === "PEM3000"
    ? modelGuess
    : "PEM3000") as Meter["model"];
  try {
    const created = await db
      .insert(meters)
      .values({
        gatewayId: gateway.id,
        name: `${model} #${slaveAddress}`,
        model,
        phases: DEFAULT_METER_PHASES[model],
        modbusAddress: slaveAddress,
        status: "online",
        lastSeenAt: new Date(),
      })
      .$returningId();
    const row = await db.select().from(meters).where(eq(meters.id, created[0].id)).limit(1);
    meterCache.set(cacheKey, row[0]);
    return row[0];
  } catch {
    // Concurrent first messages raced the insert — the row now exists, re-read it
    const raced = await db
      .select()
      .from(meters)
      .where(and(eq(meters.gatewayId, gateway.id), eq(meters.modbusAddress, slaveAddress)))
      .limit(1);
    if (raced[0]) {
      meterCache.set(cacheKey, raced[0]);
      return raced[0];
    }
    throw new Error("Failed to provision meter");
  }
}

// ─── Telemetry persistence + alarms ─────────────────────────────────────────
// Telemetry rows go through the batched writer (see api/telemetry) — at fleet
// scale this turns hundreds of single-row INSERTs per second into 1–2 bulk ones.
// Meter status updates are throttled to one UPDATE per meter per 30 s.

function touchMeter(meter: Meter, now: Date): void {
  // Liveness goes to the batched tracker — zero DB queries in the hot path.
  markMeterSeen(meter.id, now);
  meter.status = "online";
  meter.lastSeenAt = now;
}

export async function persistTelemetry(
  meter: Meter,
  values: Partial<Record<MetricKey, number>>,
  raw: unknown,
): Promise<void> {
  const now = new Date();
  getTelemetryWriter().push({ meterId: meter.id, ts: now, values, raw });
  await touchMeter(meter, now);
  await evaluateAlarmRules(meter, values);
}

// ─── Alarm evaluation ────────────────────────────────────────────────────────
// Rules are cached for 30 s — evaluating per message must not hit the DB every time.
let rulesCache: { at: number; rules: (typeof alarmRules.$inferSelect)[] } | null = null;

export function invalidateRulesCache() {
  rulesCache = null;
}

async function getEnabledRules() {
  if (rulesCache && Date.now() - rulesCache.at < 30_000) return rulesCache.rules;
  const db = getDb();
  const rules = await db.select().from(alarmRules).where(eq(alarmRules.enabled, true));
  rulesCache = { at: Date.now(), rules };
  return rules;
}

// Breach state per (ruleId, meterId), maintained in memory with hysteresis:
// an alarm fires on the transition into breach and resolves on the transition out.
// Re-alarming requires a new breach — resolving in the UI while the condition
// persists does not spam fresh alarms. DB is consulted only on first sight of a pair.
const breachState = new Map<string, boolean>();

// Hot path optimization: when the value is NOT in breach and we have no prior
// state, we assume "not breached" without a DB query. The DB is only consulted
// on the rare breach path (to avoid duplicate alarms after a server restart).
async function isCurrentlyBreached(ruleId: number, meterId: number, breached: boolean): Promise<boolean> {
  const key = `${ruleId}:${meterId}`;
  const cached = breachState.get(key);
  if (cached !== undefined) return cached;
  if (!breached) {
    breachState.set(key, false);
    return false;
  }
  const db = getDb();
  const active = await db
    .select({ id: alarms.id })
    .from(alarms)
    .where(and(eq(alarms.ruleId, ruleId), eq(alarms.meterId, meterId), eq(alarms.status, "active")))
    .limit(1);
  const was = !!active[0];
  breachState.set(key, was);
  return was;
}

async function evaluateAlarmRules(
  meter: Meter,
  values: Partial<Record<MetricKey, number>>,
): Promise<void> {
  const db = getDb();
  const rules = await getEnabledRules();
  for (const rule of rules) {
    if (rule.metric === "gatewayOffline") continue; // handled by the offline sweep
    if (rule.meterId && rule.meterId !== meter.id) continue;
    const value = values[rule.metric as MetricKey];
    if (value === undefined || value === null) continue;

    const breached = rule.operator === "gt" ? value > rule.threshold : value < rule.threshold;
    const key = `${rule.id}:${meter.id}`;
    const was = await isCurrentlyBreached(rule.id, meter.id, breached);

    if (breached && !was) {
      breachState.set(key, true);
      await db.insert(alarms).values({
        ruleId: rule.id,
        meterId: meter.id,
        gatewayId: meter.gatewayId,
        metric: rule.metric,
        value,
        threshold: rule.threshold,
        severity: rule.severity,
        message: `${rule.name}: ${rule.metric} = ${value} (${rule.operator === "gt" ? ">" : "<"} ${rule.threshold})`,
        status: "active",
        triggeredAt: new Date(),
      });
    } else if (!breached && was) {
      breachState.set(key, false);
      await db
        .update(alarms)
        .set({ status: "resolved", resolvedAt: new Date() })
        .where(
          and(eq(alarms.ruleId, rule.id), eq(alarms.meterId, meter.id), eq(alarms.status, "active")),
        );
    }
  }
}

// ─── G30 JSON uplink ─────────────────────────────────────────────────────────
const FIELD_ALIASES: Record<MetricKey, string[]> = {
  voltageL1: ["voltageL1", "U1", "u1", "V1", "v1", "Ua", "ua", "U", "voltage"],
  voltageL2: ["voltageL2", "U2", "u2", "V2", "v2", "Ub", "ub"],
  voltageL3: ["voltageL3", "U3", "u3", "V3", "v3", "Uc", "uc"],
  currentL1: ["currentL1", "I1", "i1", "Ia", "ia", "I", "current"],
  currentL2: ["currentL2", "I2", "i2", "Ib", "ib"],
  currentL3: ["currentL3", "I3", "i3", "Ic", "ic"],
  activePowerKw: ["activePowerKw", "P", "p", "Pt", "Psum", "activePower", "kW", "power"],
  reactivePowerKvar: ["reactivePowerKvar", "Q", "q", "Qt", "reactivePower", "kvar"],
  apparentPowerKva: ["apparentPowerKva", "S", "s", "St", "apparentPower", "kVA"],
  powerFactor: ["powerFactor", "PF", "pf", "PFt", "power_factor"],
  frequencyHz: ["frequencyHz", "F", "f", "Freq", "freq", "frequency", "Hz"],
  energyImportKwh: ["energyImportKwh", "Ep", "ep", "EpImp", "imp", "importEnergy", "kWh", "EPI"],
  energyExportKwh: ["energyExportKwh", "EpExp", "exp", "exportEnergy", "EPE"],
  demandKw: ["demandKw", "Dmd", "dmd", "demand"],
};

function pickNumber(obj: Record<string, unknown>, aliases: string[]): number | undefined {
  for (const key of aliases) {
    const v = obj[key];
    if (typeof v === "number" && Number.isFinite(v)) return v;
    if (typeof v === "string") {
      const n = Number(v);
      if (Number.isFinite(n)) return n;
    }
  }
  return undefined;
}

function normalizeValues(data: Record<string, unknown>): Partial<Record<MetricKey, number>> {
  const out: Partial<Record<MetricKey, number>> = {};
  for (const metric of Object.keys(FIELD_ALIASES) as MetricKey[]) {
    const v = pickNumber(data, FIELD_ALIASES[metric]);
    if (v === undefined) continue;
    // Heuristic: power values arriving in W rather than kW
    if ((metric === "activePowerKw" || metric === "reactivePowerKvar" || metric === "apparentPowerKva" || metric === "demandKw") && Math.abs(v) > 5000) {
      out[metric] = Math.round((v / 1000) * 1000) / 1000;
    } else {
      out[metric] = v;
    }
  }
  return out;
}

interface G30Reading {
  addr: number;
  model?: string;
  data: Record<string, unknown>;
}

// Accepts several plausible G30 payload shapes:
//  { addr, model, data: {...} } | [ {...}, {...} ] | { "1": {...}, "2": {...} }
export function parseG30Payload(payload: unknown): G30Reading[] {
  const readings: G30Reading[] = [];
  const push = (addr: unknown, data: unknown, model?: unknown) => {
    const a = typeof addr === "number" ? addr : Number(addr);
    if (!Number.isInteger(a) || a < 0 || a > 247) return;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      readings.push({ addr: a, data: data as Record<string, unknown>, model: typeof model === "string" ? model : undefined });
    }
  };

  if (Array.isArray(payload)) {
    for (const item of payload) {
      if (item && typeof item === "object") {
        const o = item as Record<string, unknown>;
        push(o.addr ?? o.address ?? o.slave ?? o.id, o.data ?? o.values ?? o, o.model ?? o.sn ?? o.type);
      }
    }
  } else if (payload && typeof payload === "object") {
    const o = payload as Record<string, unknown>;
    if (o.addr !== undefined || o.slave !== undefined || o.address !== undefined) {
      push(o.addr ?? o.slave ?? o.address, o.data ?? o.values ?? o, o.model ?? o.sn ?? o.type);
    } else {
      // Keyed by address: { "1": {...}, "2": {...} }
      for (const [k, v] of Object.entries(o)) {
        if (/^\d{1,3}$/.test(k)) push(Number(k), v);
      }
    }
  }
  return readings;
}

export async function handleG30Message(
  gateway: Gateway,
  payloadText: string,
): Promise<{ readings: number }> {
  let payload: unknown;
  try {
    payload = JSON.parse(payloadText);
  } catch {
    return { readings: 0 };
  }
  const readings = parseG30Payload(payload);
  let count = 0;
  for (const r of readings) {
    const values = normalizeValues(r.data);
    if (Object.keys(values).length === 0) continue;
    const meter = await ensureMeter(gateway, r.addr, r.model);
    await persistTelemetry(meter, values, r.data);
    count++;
  }
  return { readings: count };
}

// ─── C30 transparent Modbus uplink ───────────────────────────────────────────
export async function handleC30Frame(
  gateway: Gateway,
  frame: Buffer,
): Promise<{ decoded: boolean; exception?: number }> {
  const parsed = parseResponse(frame);
  if (!parsed || parsed.data === undefined) return { decoded: false };
  if (parsed.exception !== undefined) return { decoded: false, exception: parsed.exception };
  if (parsed.functionCode !== 3 && parsed.functionCode !== 4) return { decoded: false };

  const meter = await ensureMeter(gateway, parsed.slave);
  const maps = await getRegisterMaps();
  const map = maps.get(meter.model) ?? DEFAULT_REGISTER_MAPS[meter.model];
  const span = registerSpan(map);
  if (!span) return { decoded: false };

  // Try decoding against the profile span start; also try base 0 for full-range frames.
  let values = decodeRegisters(map, parsed.data, span.start);
  if (Object.keys(values).length === 0) {
    values = decodeRegisters(map, parsed.data, 0);
  }
  if (Object.keys(values).length === 0) return { decoded: false };

  await persistTelemetry(meter, values, { hex: frame.toString("hex") });
  return { decoded: true };
}
