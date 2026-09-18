// v7/C12: active control — write validated setpoints to devices.
//
// Safety model:
//  1. WHITELIST: only keys declared in device_profiles.controllable for the
//     device's model can be written — everything else is rejected before any
//     bus traffic.
//  2. VERIFICATION (Wave 5 / T1): a profile whose register map is still
//     "draft" blocks ALL writes — even whitelisted keys — until verified
//     against real hardware. The admin-only allowUnverifiedControl override
//     exists for commissioning; every write under it is logged with a
//     WARNING marker. Reads are never gated (reading is how you verify).
//  3. RANGE: values are clamp-checked against the key's min/max.
//  4. RBAC: the tRPC layer restricts execution to operator/admin (C1).
//  5. AUDIT: every attempt (success AND failure) writes a commands row with
//     userId, and the tRPC audit middleware logs the mutation.
//
// Execution paths:
//  - TCP devices (meter.host): throwaway Modbus connection, FC6 write of the
//    scaled value, then a read-back verification (status "ok" only when the
//    register reads back the written value).
//  - C30 transparent-bus devices: FC6 frame published to the gateway downlink
//    topic, then an FC3 read of the same register registered in the C30
//    outstanding-read registry (Wave 4 / T4). Status stays "sent" while the
//    bus has not answered; the correlated response flips the commands row to
//    "ok"/"failed", and the outstanding sweep fails rows with no read-back
//    within 30s.
//  - G30 JSON gateways: rejected (no downlink control channel).
import ModbusRTU from "modbus-serial";
import { eq } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { commands, deviceProfiles, gateways, meters } from "@db/schema";
import { crc16, buildReadRequest } from "../modbus";
import { registerOutstanding, attachVerifyCommand } from "../mqtt/c30-outstanding";
import type { Meter } from "@db/schema";

export interface ControllableDef {
  address: number;
  fc?: 6 | 16; // only 6 supported for now (single register); 16 reserved
  min: number;
  max: number;
  scale?: number; // register value = round(setpoint × scale), e.g. 10 → 0.1 units
  unit?: string;
  description?: string;
}

export type ControllableMap = Record<string, ControllableDef>;

export class ControlError extends Error {}

export async function controllableForModel(model: string): Promise<ControllableMap> {
  const db = getDb();
  const rows = await db.select().from(deviceProfiles).where(eq(deviceProfiles.model, model)).limit(1);
  const c = rows[0]?.controllable as ControllableMap | null | undefined;
  return c ?? {};
}

/** Wave 5 / T1: verification fields of a model's profile (null = no profile). */
export interface ProfileVerification {
  verificationStatus: "draft" | "bench_verified" | "field_verified";
  allowUnverifiedControl: boolean;
}

export async function verificationForModel(model: string): Promise<ProfileVerification | null> {
  const db = getDb();
  const rows = await db
    .select({
      verificationStatus: deviceProfiles.verificationStatus,
      allowUnverifiedControl: deviceProfiles.allowUnverifiedControl,
    })
    .from(deviceProfiles)
    .where(eq(deviceProfiles.model, model))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return { verificationStatus: r.verificationStatus, allowUnverifiedControl: r.allowUnverifiedControl === true };
}

/** Audit-log marker prepended to the command detail of every write executed
 *  under the allowUnverifiedControl commissioning override. */
export const UNVERIFIED_OVERRIDE_WARNING = "WARNING: commissioning override (allowUnverifiedControl) active — ";

function buildWriteRequest(slave: number, address: number, value: number): Buffer {
  const body = Buffer.alloc(6);
  body.writeUInt8(slave, 0);
  body.writeUInt8(6, 1); // FC6 — write single holding register
  body.writeUInt16BE(address, 2);
  body.writeUInt16BE(value & 0xffff, 4);
  const crc = crc16(body);
  const frame = Buffer.alloc(8);
  body.copy(frame, 0);
  frame.writeUInt16LE(crc, 6);
  return frame;
}

/** The statuses the commands audit table can hold — what actually reached plant. */
export type LiveControlStatus = "ok" | "sent" | "failed";

export interface ControlResult {
  // "preview" is a dry run: everything up to the bus write happened, nothing
  // was written. It is a distinct status rather than an "ok" with a prefix so
  // no caller can mistake a rehearsal for a command that reached the plant —
  // and because it is OUTSIDE LiveControlStatus, the compiler refuses to let
  // one be inserted into the commands table. The invariant is the type, not a
  // comment asking people to remember it.
  status: LiveControlStatus | "preview";
  detail: string;
  /** Wave 4 / T4: C30 writes carry the outstanding read-back registration so
   *  executeAndLog can link the control commands row once inserted. */
  verify?: { gatewayId: number; slave: number; fc: 3 | 4 };
}

export interface ExecuteOptions {
  /**
   * §9.4: validate everything and report what WOULD happen, without touching
   * the bus. Deliberately the same function rather than a parallel "preview"
   * implementation — a rehearsal that ran different code from the performance
   * would be worth less than no rehearsal at all.
   */
  dryRun?: boolean;
}

/**
 * §9.4 emergency stop. Read straight from the database rather than trusting
 * the Meter row the caller is holding: those rows come from caches with
 * multi-minute lifetimes, and a stop that takes effect in five minutes is not
 * a stop. One small query on a path that is about to talk to plant anyway.
 */
async function controlLock(
  meterId: number,
): Promise<{ at: Date; by: number | null; reason: string | null } | null> {
  const rows = await getDb()
    .select({
      at: meters.controlLockedAt,
      by: meters.controlLockedBy,
      reason: meters.controlLockReason,
    })
    .from(meters)
    .where(eq(meters.id, meterId))
    .limit(1);
  const row = rows[0];
  return row?.at ? { at: row.at, by: row.by ?? null, reason: row.reason ?? null } : null;
}

/**
 * Validate + execute a setpoint write. Throws ControlError for validation
 * failures (not whitelisted / out of range / unsupported transport) — those
 * are logged as failed commands by the caller path via executeAndLog.
 *
 * This is the one chokepoint every writer passes through: manual control, the
 * grid connection limit, peak shaving, optimizer plans, schedules and the
 * watchdog refresh. The §9.4 lock is enforced here for exactly that reason —
 * a controller added later inherits it rather than having to remember it.
 */
export async function executeControl(
  meter: Meter,
  key: string,
  value: number,
  opts: ExecuteOptions = {},
): Promise<ControlResult> {
  // The lock comes first and is absolute: a device someone has stopped is not
  // written to, whatever the reason and whichever controller is asking. A dry
  // run is allowed through to report on it — describing a write is not one.
  const lock = opts.dryRun ? null : await controlLock(meter.id);
  if (lock) {
    throw new ControlError(
      `${meter.name} is under an emergency stop since ${lock.at.toISOString()}` +
        (lock.reason ? ` (${lock.reason})` : "") +
        ". Release it before commanding this device.",
    );
  }
  const allowed = await controllableForModel(meter.model);
  const def = allowed[key];
  if (!def) {
    throw new ControlError(
      `'${key}' is not controllable on model ${meter.model}` +
        (Object.keys(allowed).length ? ` (allowed: ${Object.keys(allowed).join(", ")})` : " (model has no writable registers)"),
    );
  }
  // Wave 5 / T1: verification gate — AFTER the whitelist lookup, BEFORE any
  // bus traffic. A draft (unverified) register map blocks even a whitelisted
  // key: an unreviewed address on a write path can hit a protection threshold
  // or calibration constant on a live battery. Reads are unaffected.
  const verification = await verificationForModel(meter.model);
  const draftOverride =
    verification !== null && verification.verificationStatus === "draft" && verification.allowUnverifiedControl;
  if (verification !== null && verification.verificationStatus === "draft" && !verification.allowUnverifiedControl) {
    throw new ControlError(
      `Profile "${meter.model}" is unverified. Control is blocked until the register ` +
        `map has been verified against real hardware (Settings → Device profiles → Verify).`,
    );
  }
  // Under the commissioning override the write proceeds but every logged
  // command row carries a clearly visible WARNING marker.
  const withWarn = (r: ControlResult): ControlResult =>
    draftOverride ? { ...r, detail: UNVERIFIED_OVERRIDE_WARNING + r.detail } : r;
  if (!Number.isFinite(value) || value < def.min || value > def.max) {
    throw new ControlError(`value ${value} out of range for '${key}' [${def.min}..${def.max}]`);
  }
  if (def.fc && def.fc !== 6) throw new ControlError(`fc${def.fc} writes not supported yet (FC6 only)`);
  const scale = def.scale ?? 1;
  const registerValue = Math.round(value * scale);
  if (registerValue < 0 || registerValue > 0xffff) {
    throw new ControlError(`scaled value ${registerValue} does not fit a 16-bit register`);
  }

  if (opts.dryRun) {
    // Everything above this line is the real path: whitelist, verification
    // gate, range check, FC support and scaling all ran exactly as they would
    // have. Only the bus write is skipped.
    const stopped = await controlLock(meter.id);
    return withWarn({
      status: "preview",
      detail:
        `would write ${value}${def.unit ? ` ${def.unit}` : ""} to register ${def.address} ` +
        `(scaled ${registerValue}) on ${meter.name}` +
        (stopped
          ? ` — BUT the device is under an emergency stop${stopped.reason ? ` (${stopped.reason})` : ""}, so a real command would be refused`
          : ""),
    });
  }

  const db = getDb();
  if (meter.host) {
    // Direct TCP device: write + read-back verify on a throwaway connection.
    const client = new ModbusRTU();
    const port = meter.port ?? 502;
    const unitId = meter.unitId ?? meter.modbusAddress;
    try {
      await client.connectTCP(meter.host, { port });
      client.setID(unitId);
      client.setTimeout(8000);
      await client.writeRegister(def.address, registerValue);
      const read = await client.readHoldingRegisters(def.address, 1);
      const actual = read.data?.[0];
      if (actual !== registerValue) {
        return withWarn({ status: "failed", detail: `read-back mismatch: wrote ${registerValue} but register ${def.address} reads ${actual}` });
      }
      return withWarn({ status: "ok", detail: `wrote ${value}${def.unit ? ` ${def.unit}` : ""} (register ${def.address} = ${registerValue}) — verified by read-back` });
    } catch (err) {
      return withWarn({ status: "failed", detail: err instanceof Error ? err.message : String(err) });
    } finally {
      try {
        await client.close(() => undefined);
      } catch {
        /* connection already gone */
      }
    }
  }

  // Bus device behind a gateway: only C30 transparent has a downlink channel.
  const gwRows = await db.select().from(gateways).where(eq(gateways.id, meter.gatewayId)).limit(1);
  const gateway = gwRows[0];
  if (!gateway) return withWarn({ status: "failed", detail: `gateway ${meter.gatewayId} not found` });
  if (gateway.transport !== "transparent") {
    return withWarn({ status: "failed", detail: `model ${meter.model} is behind a ${gateway.model} gateway which has no downlink control channel (C30 transparent only)` });
  }
  const { sendControlFrame } = await import("../mqtt/service");
  const slave = meter.unitId ?? meter.modbusAddress;
  if (slave < 1 || slave > 255) return withWarn({ status: "failed", detail: `bus address ${slave} out of Modbus range` });
  const frame = buildWriteRequest(slave, def.address, registerValue);
  await sendControlFrame(gateway, frame);
  // Wave 4 / T4: read-back verification through the T1 correlation machinery.
  // The FC6 echo alone proves nothing on a transparent bus — issue an FC3 read
  // of the written register and register it as outstanding; the correlated
  // response (or the 30 s sweep) flips the commands row to ok/failed.
  const readFrame = buildReadRequest(slave, 3, def.address, 1);
  await sendControlFrame(gateway, readFrame);
  registerOutstanding({
    gatewayId: gateway.id,
    slave,
    fc: 3,
    start: def.address,
    quantity: 1,
    verifyExpected: registerValue,
  });
  return withWarn({
    status: "sent",
    detail: `FC6 frame sent to ${gateway.uid} downlink (register ${def.address} = ${registerValue}) — read-back verification pending (30s)`,
    verify: { gatewayId: gateway.id, slave, fc: 3 },
  });
}

/** Execute + ALWAYS log to commands (audit trail), rethrowing ControlError. */
/**
 * executeControl + an audit row. Deliberately has no dry-run parameter: the
 * commands table is the record of what was sent to plant, and a rehearsal that
 * left a row there would be indistinguishable from the real thing in the one
 * place an incident review looks. Previews go through executeControl directly.
 */
export async function executeAndLog(meter: Meter, key: string, value: number, userId: number | null): Promise<ControlResult> {
  const db = getDb();
  try {
    const result = await executeControl(meter, key, value);
    if (result.status === "preview") {
      // Unreachable: this function never asks for a dry run, and that is the
      // point — the narrowing below is what lets the insert typecheck, so the
      // day someone adds a dryRun parameter here they get a compile error
      // rather than rehearsals quietly logged as real commands.
      throw new Error("internal: preview result returned from a live control write");
    }
    const inserted = await db
      .insert(commands)
      .values({
        gatewayId: meter.gatewayId,
        meterId: meter.id,
        kind: "control",
        payloadHex: "-",
        topic: `control:${meter.model}`,
        status: result.status,
        userId,
        controlKey: key,
        controlValue: value,
        result: result.detail,
      })
      .$returningId();
    // Wave 4 / T4: link the audit row to the outstanding read-back so the
    // correlated response (or sweep) can update THIS row.
    const controlCommandId = inserted[0]?.id;
    if (result.verify && controlCommandId !== undefined) {
      attachVerifyCommand(result.verify.gatewayId, result.verify.slave, result.verify.fc, controlCommandId);
    }
    return result;
  } catch (err) {
    if (err instanceof ControlError) {
      await db.insert(commands).values({
        gatewayId: meter.gatewayId,
        meterId: meter.id,
        kind: "control",
        payloadHex: "-",
        topic: `control:${meter.model}`,
        status: "failed",
        userId,
        controlKey: key,
        controlValue: value,
        result: `rejected: ${err.message}`,
      });
    }
    throw err;
  }
}
