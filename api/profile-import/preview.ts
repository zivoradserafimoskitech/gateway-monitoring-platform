// Wave 5 / T2: live-read preview for profile import.
//
// Reads a device's CURRENT values for an arbitrary register map — the same
// Modbus TCP client (modbus-serial) and the same block planning + decoder the
// poller uses (buildBlocks/decodeRegisters, read-only FC3/FC4), on a throwaway
// connection like api/poller/test-connection.ts. Kept as a standalone helper
// because Task 3's bench-verification workflow polls keys exactly the same way.
//
// Scope: direct Modbus TCP devices (meter.host set). Bus devices behind a
// gateway have no synchronous read channel (MQTT uplinks are async — same
// limitation as meters.testConnection), so they get a clear per-device error.
import ModbusRTU from "modbus-serial";
import { decodeRawValue, buildBlocks } from "../modbus";
import { shiftedAddress, type RegisterDef } from "@contracts/modbus";
import type { Meter } from "@db/schema";

export interface LiveValue {
  key: string;
  raw?: number;
  value?: number; // scaled: raw × scale + offset
  error?: string;
}

export interface LiveReadResult {
  ok: boolean;
  error?: string; // device-level failure (no TCP host, connect failed, …)
  values: Record<string, LiveValue>;
}

/**
 * Read + decode a set of register defs against a live device. READ-ONLY —
 * only FC3/FC4 reads are ever issued, regardless of the defs' fc.
 */
export async function readDeviceRegisters(meter: Meter, defs: RegisterDef[]): Promise<LiveReadResult> {
  const empty: Record<string, LiveValue> = {};
  if (!meter.host) {
    return {
      ok: false,
      error:
        "live preview requires a direct Modbus TCP device (host set) — bus devices behind a " +
        "gateway have no synchronous read channel",
      values: empty,
    };
  }
  // Only readable rows (FC3/FC4); write-only defs (fc 6/16) never hit the wire.
  const readable = defs.filter((d) => d.functionCode === 3 || d.functionCode === 4);
  if (readable.length === 0) return { ok: true, values: empty };

  const unitId = meter.unitId ?? meter.modbusAddress;
  const shifted = readable.some((d) => d.addressStride)
    ? readable.map((d) => ({ ...d, address: shiftedAddress(d, unitId) }))
    : readable;
  const blocks = buildBlocks(shifted);

  const client = new ModbusRTU();
  client.setTimeout(8000);
  const values: Record<string, LiveValue> = {};
  try {
    await client.connectTCP(meter.host, { port: meter.port ?? 502 });
    client.setID(unitId);
    for (const block of blocks) {
      let buffer: Buffer;
      try {
        const res =
          block.functionCode === 3
            ? await client.readHoldingRegisters(block.start, block.words)
            : await client.readInputRegisters(block.start, block.words);
        buffer = res.buffer;
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        for (const d of block.defs) values[d.key] = { key: d.key, error: msg };
        continue;
      }
      for (const d of block.defs) {
        const raw = decodeRawValue(d, buffer, block.start);
        if (raw === undefined || !Number.isFinite(raw)) {
          values[d.key] = { key: d.key, error: "register not in response" };
          continue;
        }
        values[d.key] = { key: d.key, raw, value: Math.round((raw * d.scale + (d.offset ?? 0)) * 10000) / 10000 };
      }
    }
    return { ok: true, values };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), values };
  } finally {
    try {
      client.close(() => undefined);
    } catch {
      /* connection already gone */
    }
  }
}
