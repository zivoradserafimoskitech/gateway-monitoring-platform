// v7/C12: active control — write validated setpoints to devices.
//
// Safety model:
//  1. WHITELIST: only keys declared in device_profiles.controllable for the
//     device's model can be written — everything else is rejected before any
//     bus traffic.
//  2. RANGE: values are clamp-checked against the key's min/max.
//  3. RBAC: the tRPC layer restricts execution to operator/admin (C1).
//  4. AUDIT: every attempt (success AND failure) writes a commands row with
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
import { commands, deviceProfiles, gateways } from "@db/schema";
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

export interface ControlResult {
  status: "ok" | "sent" | "failed";
  detail: string;
  /** Wave 4 / T4: C30 writes carry the outstanding read-back registration so
   *  executeAndLog can link the control commands row once inserted. */
  verify?: { gatewayId: number; slave: number; fc: 3 | 4 };
}

/**
 * Validate + execute a setpoint write. Throws ControlError for validation
 * failures (not whitelisted / out of range / unsupported transport) — those
 * are logged as failed commands by the caller path via executeAndLog.
 */
export async function executeControl(meter: Meter, key: string, value: number): Promise<ControlResult> {
  const allowed = await controllableForModel(meter.model);
  const def = allowed[key];
  if (!def) {
    throw new ControlError(
      `'${key}' is not controllable on model ${meter.model}` +
        (Object.keys(allowed).length ? ` (allowed: ${Object.keys(allowed).join(", ")})` : " (model has no writable registers)"),
    );
  }
  if (!Number.isFinite(value) || value < def.min || value > def.max) {
    throw new ControlError(`value ${value} out of range for '${key}' [${def.min}..${def.max}]`);
  }
  if (def.fc && def.fc !== 6) throw new ControlError(`fc${def.fc} writes not supported yet (FC6 only)`);
  const scale = def.scale ?? 1;
  const registerValue = Math.round(value * scale);
  if (registerValue < 0 || registerValue > 0xffff) {
    throw new ControlError(`scaled value ${registerValue} does not fit a 16-bit register`);
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
        return { status: "failed", detail: `read-back mismatch: wrote ${registerValue} but register ${def.address} reads ${actual}` };
      }
      return { status: "ok", detail: `wrote ${value}${def.unit ? ` ${def.unit}` : ""} (register ${def.address} = ${registerValue}) — verified by read-back` };
    } catch (err) {
      return { status: "failed", detail: err instanceof Error ? err.message : String(err) };
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
  if (!gateway) return { status: "failed", detail: `gateway ${meter.gatewayId} not found` };
  if (gateway.transport !== "transparent") {
    return { status: "failed", detail: `model ${meter.model} is behind a ${gateway.model} gateway which has no downlink control channel (C30 transparent only)` };
  }
  const { sendControlFrame } = await import("../mqtt/service");
  const slave = meter.unitId ?? meter.modbusAddress;
  if (slave < 1 || slave > 255) return { status: "failed", detail: `bus address ${slave} out of Modbus range` };
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
  return {
    status: "sent",
    detail: `FC6 frame sent to ${gateway.uid} downlink (register ${def.address} = ${registerValue}) — read-back verification pending (30s)`,
    verify: { gatewayId: gateway.id, slave, fc: 3 },
  };
}

/** Execute + ALWAYS log to commands (audit trail), rethrowing ControlError. */
export async function executeAndLog(meter: Meter, key: string, value: number, userId: number | null): Promise<ControlResult> {
  const db = getDb();
  try {
    const result = await executeControl(meter, key, value);
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
