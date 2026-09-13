// Message handlers: normalize G30 JSON uplinks and C30 transparent Modbus frames
// into telemetry rows, and evaluate alarm rules.
import { eq, and, inArray } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { meters, alarmRules, alarms, alarmBreachState, deviceProfiles } from "@db/schema";
import { getTelemetryWriter } from "../telemetry";
import { markMeterSeen } from "./liveness";
import type { MetricKey, RegisterDef } from "@contracts/modbus";
import { DEFAULT_REGISTER_MAPS, DEFAULT_METER_PHASES } from "@contracts/modbus";
import { parseResponse, decodeRegisters, registerSpan, buildBlocks } from "../modbus";
import { shiftedAddress } from "@contracts/modbus";
import { isInMaintenance, notifyAlarmBreach, notifyAlarmResolved } from "../alarms/notify";
import { alarmTransition } from "../alarms/hysteresis";
import { telemetryValueRejected, telemetryValueDecoded, c30FrameUndecodable } from "../lib/observability";
import { matchOutstanding, stampResponded, confirmVerifiedWrite } from "./c30-outstanding";
import type { Gateway, Meter } from "@db/schema";

// ─── Register maps (DB-backed, seeded from defaults) ────────────────────────
let profileCache: {
  at: number;
  maps: Map<string, RegisterDef[]>;
  meta: Map<string, { deviceType: string; brand: string | null }>;
} | null = null;

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
  const meta = new Map<string, { deviceType: string; brand: string | null }>();
  for (const r of rows) {
    maps.set(r.model, r.registerMap as RegisterDef[]);
    meta.set(r.model, { deviceType: r.deviceType, brand: r.brand });
  }
  profileCache = { at: Date.now(), maps, meta };
  return maps;
}

// v6/R10: profile metadata (deviceType/brand) for auto-provisioning.
export async function getProfileMeta(): Promise<Map<string, { deviceType: string; brand: string | null }>> {
  await getRegisterMaps();
  return profileCache!.meta;
}

export function invalidateProfileCache() {
  profileCache = null;
}

// ─── Auto-provisioning ───────────────────────────────────────────────────────
// Meters are cached in memory — at fleet scale every MQTT message would
// otherwise cost a metadata lookup, and the steady-state meter set is small
// enough (tens of thousands) to hold in RAM. Entries EXPIRE so that rows
// deleted or re-provisioned externally are eventually re-read (incident v2:
// a boot-time warmed cache kept serving meters whose gateway rows had been
// deleted afterwards → orphan meters/telemetry under dead gateway ids).
export const meterCache = new Map<string, { at: number; meter: Meter }>();
const METER_CACHE_TTL_MS = 600_000; // 10 min — ~0 extra DB load at ≥15 s publish rates

// Called by routers after meter/gateway deletes so the ingestion path can't
// resurrect removed rows from cache (#16). Full clear is fine — deletes are
// rare and the cache repopulates on the next message.
export function clearMeterCache(): void {
  meterCache.clear();
}

// v6/R10: one warning per unknown model, not one per message.
const unknownModelWarned = new Set<string>();

export async function ensureMeter(
  gateway: Gateway,
  slaveAddress: number,
  modelGuess?: string,
): Promise<Meter> {
  const cacheKey = `${gateway.id}:${slaveAddress}`;
  const cached = meterCache.get(cacheKey);
  if (cached && Date.now() - cached.at < METER_CACHE_TTL_MS) return cached.meter;

  const db = getDb();
  const existing = await db
    .select()
    .from(meters)
    .where(and(eq(meters.gatewayId, gateway.id), eq(meters.modbusAddress, slaveAddress)))
    .limit(1);
  if (existing[0]) {
    meterCache.set(cacheKey, { at: Date.now(), meter: existing[0] });
    return existing[0];
  }

  // v6/R10: any model that has a device profile is accepted (PV inverters,
  // BESS, weather stations included), with deviceType/brand taken from the
  // profile. Unknown guesses fall back to PEM3000 with a one-time warning —
  // before, only three VoltTrade models were recognized and everything else
  // was silently mis-provisioned as a meter.
  const meta = await getProfileMeta();
  let model = "PEM3000";
  let deviceType = "meter";
  let brand: string | null = "VoltTrade";
  if (modelGuess && meta.has(modelGuess)) {
    model = modelGuess;
    deviceType = meta.get(modelGuess)!.deviceType;
    brand = meta.get(modelGuess)!.brand;
  } else if (modelGuess) {
    if (!unknownModelWarned.has(modelGuess)) {
      unknownModelWarned.add(modelGuess);
      console.warn(
        `[mqtt] auto-provision: unknown model "${modelGuess}" on gateway ${gateway.uid} addr ${slaveAddress} — falling back to PEM3000`,
      );
    }
  }
  try {
    const created = await db
      .insert(meters)
      .values({
        gatewayId: gateway.id,
        name: `${model} #${slaveAddress}`,
        model,
        deviceType,
        brand,
        phases: (DEFAULT_METER_PHASES as Record<string, "single" | "three">)[model] ?? "three",
        modbusAddress: slaveAddress,
        status: "online",
        lastSeenAt: new Date(),
        // §1.4: inherit the gateway's tenant. A meter on a gateway that HAS an
        // owner used to be created with org_id NULL anyway, so it was invisible
        // to the very tenant that owns the gateway it hangs off — the device
        // arrived on that tenant's own uplink, so there is nothing to guess.
        orgId: gateway.orgId ?? null,
        siteId: gateway.siteId ?? null,
      })
      .$returningId();
    const row = await db.select().from(meters).where(eq(meters.id, created[0].id)).limit(1);
    meterCache.set(cacheKey, { at: Date.now(), meter: row[0] });
    return row[0];
  } catch {
    // Concurrent first messages raced the insert — the row now exists, re-read it
    const raced = await db
      .select()
      .from(meters)
      .where(and(eq(meters.gatewayId, gateway.id), eq(meters.modbusAddress, slaveAddress)))
      .limit(1);
    if (raced[0]) {
      meterCache.set(cacheKey, { at: Date.now(), meter: raced[0] });
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
  values: Record<string, number>,
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

// MySQL/TiDB duplicate-key error (1062) on the active_dedup_key unique index.
export function isDuplicateKey(err: unknown): boolean {
  const e = err as { code?: string; errno?: number; message?: string } | null;
  return (
    !!e &&
    (e.errno === 1062 ||
      e.code === "ER_DUP_ENTRY" ||
      (e.message ?? "").includes("Duplicate entry"))
  );
}

// Breach state per (ruleId, meterId): an alarm fires on the transition INTO
// breach and resolves on the transition out. Re-alarming requires a new
// breach, so resolving in the UI while the condition persists does not spam
// fresh alarms.
//
// The authority is the alarm_breach_state table, because MQTT ingestion is
// deliberately NOT leased — the shared subscription balances it across
// replicas on purpose — so both replicas evaluate the same rules. With
// per-process state each kept its own view: a breach could be raised twice, or
// a clear missed entirely, and every restart forgot how long a condition had
// been going.
//
// The map stays as a read-through cache so the hot path (unchanged state,
// every sample) does not touch the database. Only TRANSITIONS are written.
interface BreachRecord {
  breached: boolean;
  /** When the condition started. Null when not breached. */
  since: number | null;
  /** When the rule actually fired, for duration rules. Null until it does. */
  raisedAt: number | null;
}
const breachState = new Map<string, BreachRecord>();

const breachKey = (ruleId: number, meterId: number) => `${ruleId}:${meterId}`;

/** Current record, consulting the database on first sight of a pair. */
async function loadBreachState(
  ruleId: number,
  meterId: number,
  breachedNow: boolean,
): Promise<BreachRecord> {
  const key = breachKey(ruleId, meterId);
  const cached = breachState.get(key);
  if (cached !== undefined) return cached;

  const db = getDb();
  try {
    const rows = await db
      .select()
      .from(alarmBreachState)
      .where(and(eq(alarmBreachState.ruleId, ruleId), eq(alarmBreachState.meterId, meterId)))
      .limit(1);
    const row = rows[0];
    if (row) {
      const rec: BreachRecord = {
        breached: row.breached === true || (row.breached as unknown) === 1,
        since: row.since ? row.since.getTime() : null,
        raisedAt: row.raisedAt ? row.raisedAt.getTime() : null,
      };
      breachState.set(key, rec);
      return rec;
    }
  } catch (err) {
    console.warn(
      "[alarms] breach state unavailable, falling back to alarm rows:",
      err instanceof Error ? err.message : err,
    );
  }

  // No stored state. Not in breach means nothing to reconstruct.
  if (!breachedNow) {
    const rec: BreachRecord = { breached: false, since: null, raisedAt: null };
    breachState.set(key, rec);
    return rec;
  }
  // In breach with no stored state: an open alarm row means the condition was
  // already known. #7: an ACKNOWLEDGED alarm is still an ongoing breach —
  // counting only "active" re-fired a fresh alarm for a condition the operator
  // had already acknowledged.
  const active = await db
    .select({ id: alarms.id, triggeredAt: alarms.triggeredAt })
    .from(alarms)
    .where(
      and(
        eq(alarms.ruleId, ruleId),
        eq(alarms.meterId, meterId),
        inArray(alarms.status, ["active", "acknowledged"]),
      ),
    )
    .limit(1);
  const rec: BreachRecord = active[0]
    ? {
        breached: true,
        since: active[0].triggeredAt ? new Date(active[0].triggeredAt).getTime() : Date.now(),
        raisedAt: active[0].triggeredAt ? new Date(active[0].triggeredAt).getTime() : Date.now(),
      }
    : { breached: false, since: null, raisedAt: null };
  breachState.set(key, rec);
  return rec;
}

/** Persist a transition. Cache first so the hot path never waits on the write. */
async function saveBreachState(ruleId: number, meterId: number, rec: BreachRecord): Promise<void> {
  breachState.set(breachKey(ruleId, meterId), rec);
  try {
    const db = getDb();
    const values = {
      ruleId,
      meterId,
      breached: rec.breached,
      since: rec.since === null ? null : new Date(rec.since),
      raisedAt: rec.raisedAt === null ? null : new Date(rec.raisedAt),
    };
    await db
      .insert(alarmBreachState)
      .values(values)
      .onDuplicateKeyUpdate({
        set: { breached: values.breached, since: values.since, raisedAt: values.raisedAt },
      });
  } catch (err) {
    console.warn(
      "[alarms] breach state write failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

/** Test seam: drop the cache so the next evaluation re-reads the database. */
export function invalidateBreachCache(): void {
  breachState.clear();
}

async function evaluateAlarmRules(
  meter: Meter,
  values: Record<string, number>,
): Promise<void> {
  const db = getDb();
  const rules = await getEnabledRules();
  for (const rule of rules) {
    if (rule.metric === "gatewayOffline") continue; // handled by the offline sweep
    if (rule.meterId && rule.meterId !== meter.id) continue;
    // Tenancy: a fleet-wide rule (meterId null) belongs to the org that
    // created it and must not evaluate against another tenant's meters. A
    // NULL-org rule is a global/system rule and applies everywhere.
    if (rule.orgId != null && rule.orgId !== (meter.orgId ?? null)) continue;
    const value = values[rule.metric];
    if (value === undefined || value === null) continue;

    const breached = rule.operator === "gt" ? value > rule.threshold : value < rule.threshold;
    const now = Date.now();
    const durationMs = (rule.durationSec ?? 0) * 1000;
    const rec = await loadBreachState(rule.id, meter.id, breached);
    const decision = alarmTransition(rec, breached, now, durationMs);

    if (decision.action === "none") {
      // The clock may still have started or reset, which has to survive a
      // restart for a duration rule to ever accumulate.
      if (
        decision.next.breached !== rec.breached ||
        decision.next.since !== rec.since ||
        decision.next.raisedAt !== rec.raisedAt
      ) {
        await saveBreachState(rule.id, meter.id, decision.next);
      }
      continue;
    }

    if (decision.action === "raise") {
      // v7/C2: maintenance windows suppress NEW activations (evaluation keeps
      // running — resolves still flow through below).
      if (await isInMaintenance(meter)) continue;
      // #7 race-proofing: the unique generated column active_dedup_key
      // (rule:meter:gateway:metric while status active/acknowledged) makes the
      // check+insert atomic ACROSS processes/reloads. A duplicate-key error
      // means another evaluator won the race — the alarm already exists.
      try {
        const inserted = await db
          .insert(alarms)
          .values({
            ruleId: rule.id,
            meterId: meter.id,
            gatewayId: meter.gatewayId,
            metric: rule.metric,
            value,
            threshold: rule.threshold,
            severity: rule.severity,
            message:
              `${rule.name}: ${rule.metric} = ${value} ` +
              `(${rule.operator === "gt" ? ">" : "<"} ${rule.threshold}` +
              (durationMs > 0 ? ` for ${Math.round(durationMs / 60_000)} min` : "") +
              ")",
            status: "active",
            triggeredAt: new Date(),
          })
          .$returningId();
        // v7/C2: fire-and-forget notification — never block ingestion on a
        // slow channel.
        if (inserted[0]?.id) void notifyAlarmBreach(inserted[0].id);
        await saveBreachState(rule.id, meter.id, decision.next);
      } catch (err) {
        if (isDuplicateKey(err)) {
          // Another replica won the race; it owns the alarm row, and our state
          // must agree or we would try to raise it again on the next sample.
          await saveBreachState(rule.id, meter.id, decision.next);
          continue;
        }
        throw err;
      }
    } else {
      await saveBreachState(rule.id, meter.id, decision.next);
      // Resolve acknowledged alarms too — the breach is over either way (#7).
      // Collect the ids first: the UPDATE nulls active_dedup_key, so after it
      // runs there is no way to find which rows were just closed, and whoever
      // was paged needs a return-to-normal notice.
      const closing = await db
        .select({ id: alarms.id })
        .from(alarms)
        .where(
          and(
            eq(alarms.ruleId, rule.id),
            eq(alarms.meterId, meter.id),
            inArray(alarms.status, ["active", "acknowledged"]),
          ),
        );
      await db
        .update(alarms)
        .set({ status: "resolved", resolvedAt: new Date() })
        .where(
          and(
            eq(alarms.ruleId, rule.id),
            eq(alarms.meterId, meter.id),
            inArray(alarms.status, ["active", "acknowledged"]),
          ),
        );
      for (const c of closing) void notifyAlarmResolved(c.id);
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

// #9: unit handling is now metadata-driven. If the device's register map
// declares the key's engineering unit, it decides: "kW"/"kvar"/"kVA" mean the
// value is already normalized, "W"/"var"/"VA" always convert. Only when the
// profile says nothing do we fall back to the magnitude heuristic.
const POWER_METRICS = new Set(["activePowerKw", "reactivePowerKvar", "apparentPowerKva", "demandKw"]);
const POWER_SOURCE_UNITS = new Set(["W", "var", "VA", "Wh"]);

// v6/R8: open-key unit handling. JSON uplinks carry engineering values; when
// the profile declares a W-class source unit for a key whose canonical name is
// kW-class (…Kw/…Kvar/…Kva) or Wh for …Kwh, convert — otherwise pass through.
function normalizeOpenKey(key: string, v: number, unit: string | undefined): number {
  if (!unit) return v;
  const needsDiv =
    (POWER_SOURCE_UNITS.has(unit) && /k(w|var|va)$/i.test(key)) ||
    (unit === "Wh" && /kwh$/i.test(key));
  return needsDiv ? Math.round((v / 1000) * 1000) / 1000 : v;
}

// Exported for unit tests (tests/normalize.test.ts).
export function normalizeValues(
  data: Record<string, unknown>,
  unitHints?: Map<string, string>,
  extraKeys?: Iterable<string>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const metric of Object.keys(FIELD_ALIASES) as MetricKey[]) {
    const v = pickNumber(data, FIELD_ALIASES[metric]);
    if (v === undefined) continue;
    if (POWER_METRICS.has(metric)) {
      const unit = unitHints?.get(metric);
      if (unit !== undefined && !POWER_SOURCE_UNITS.has(unit)) {
        out[metric] = v; // profile says the value is already in kW-class units
        continue;
      }
      if (unit !== undefined || Math.abs(v) > 5000) {
        out[metric] = Math.round((v / 1000) * 1000) / 1000;
        continue;
      }
    }
    out[metric] = v;
  }
  // v6/R8: pass through any other numeric payload key that the device's
  // profile declares — this is what makes MQTT a real option for PV inverters
  // and BESS (dcPowerKw, socPercent, energyTotalKwh, …), whose keys are not
  // part of the 14 meter aliases and were silently dropped before.
  if (extraKeys) {
    for (const key of extraKeys) {
      if (key in out) continue;
      const v = pickNumber(data, [key]);
      if (v === undefined) continue;
      out[key] = normalizeOpenKey(key, v, unitHints?.get(key));
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
  const maps = await getRegisterMaps();
  let count = 0;
  for (const r of readings) {
    const meter = await ensureMeter(gateway, r.addr, r.model);
    // Unit hints from the meter's profile drive W→kW normalization (#9).
    const map = maps.get(meter.model);
    const hints = map ? new Map(map.map((d) => [d.key, d.unit ?? ""])) : undefined;
    // v6/R8: also accept the profile's open keys (PV/BESS/weather telemetry).
    const values = normalizeValues(r.data, hints, map?.map((d) => d.key));
    if (Object.keys(values).length === 0) continue;
    await persistTelemetry(meter, values, r.data);
    count++;
  }
  return { readings: count };
}

// ─── C30 transparent Modbus uplink ───────────────────────────────────────────
// A Modbus RTU response carries NO start address. Attribution order (T1):
//  (a) a correlated outstanding read (same gateway+slave+fc, byteCount ===
//      quantity*2) → decode against the REQUESTED base, which is known;
//  (b) an unsolicited frame → accept only when EXACTLY ONE profile block
//      matches the byte count, decode against that block's start;
//  (c) otherwise DROP the frame and count it (c30_frames_undecodable_total).
// Missing data is recoverable; silently mis-decoded data reaches billing.
export async function handleC30Frame(
  gateway: Gateway,
  frame: Buffer,
): Promise<{ decoded: boolean; exception?: number; baseAddress?: number }> {
  const parsed = parseResponse(frame);
  if (!parsed || parsed.data === undefined) return { decoded: false };
  if (parsed.exception !== undefined) return { decoded: false, exception: parsed.exception };
  if (parsed.functionCode !== 3 && parsed.functionCode !== 4) return { decoded: false };

  const meter = await ensureMeter(gateway, parsed.slave);
  const maps = await getRegisterMaps();
  const baseMap =
    maps.get(meter.model) ??
    (DEFAULT_REGISTER_MAPS as Record<string, RegisterDef[]>)[meter.model] ??
    DEFAULT_REGISTER_MAPS.PEM3000;
  // v6/R9: mirror the poller — multi-unit devices (ESMU ESBCM strings) live at
  // shifted address blocks per unit; the C30 path used the raw map and could
  // only ever decode unit 1.
  const unitId = meter.unitId ?? parsed.slave;
  const map = baseMap.some((d) => d.addressStride)
    ? baseMap.map((d) => ({ ...d, address: shiftedAddress(d, unitId) }))
    : baseMap;

  // (a) Correlated response to a read we issued (readNow / control read-back).
  const matched = matchOutstanding(gateway.id, parsed.slave, parsed.functionCode, parsed.data.length);
  let baseAddress: number;
  if (matched) {
    baseAddress = matched.start;
    if (matched.commandId !== undefined) await stampResponded(matched.commandId);
    if (matched.verifyExpected !== undefined) {
      // T4: control write read-back — compare the first register and mark the
      // control command row ok/failed. Telemetry decode below still runs.
      await confirmVerifiedWrite(matched, parsed.data.readUInt16BE(0));
    }
  } else {
    // (b) Unsolicited frame: attribute only when exactly one block of the
    // profile matches the response's byte count — never guess.
    const blocks = buildBlocks(map);
    const candidates = blocks.filter(
      (b) => b.functionCode === parsed.functionCode && b.words * 2 === parsed.data!.length,
    );
    if (candidates.length !== 1) {
      c30FrameUndecodable(
        candidates.length > 1 ? "ambiguous" : registerSpan(map) === null ? "span_too_wide" : "no_match",
      );
      return { decoded: false };
    }
    baseAddress = candidates[0].start;
  }

  const decoded = decodeRegisters(map, parsed.data, baseAddress);
  for (const key of Object.keys(decoded.values)) telemetryValueDecoded(key);
  for (const r of decoded.rejected) telemetryValueRejected(r.key);
  if (Object.keys(decoded.values).length > 0) {
    await persistTelemetry(meter, decoded.values, { hex: frame.toString("hex") });
  }
  // A correlated frame is "decoded" (attributed) even when no register of the
  // profile landed inside the requested block — it was provably our response.
  return { decoded: true, baseAddress };
}
