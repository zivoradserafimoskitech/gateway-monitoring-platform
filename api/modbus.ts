// Minimal Modbus RTU codec for the C30 transparent channel.
// Frames travel as raw binary inside MQTT payloads (d2g/{uid} up, g2d/{uid} down).
import type { RegisterDef, MetricKey } from "@contracts/modbus";

export function crc16(buf: Buffer): number {
  let crc = 0xffff;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = crc & 1 ? (crc >> 1) ^ 0xa001 : crc >> 1;
    }
  }
  return crc;
}

export function buildReadRequest(
  slave: number,
  functionCode: 3 | 4,
  startAddress: number,
  quantity: number,
): Buffer {
  const body = Buffer.alloc(6);
  body.writeUInt8(slave, 0);
  body.writeUInt8(functionCode, 1);
  body.writeUInt16BE(startAddress, 2);
  body.writeUInt16BE(quantity, 4);
  const crc = crc16(body);
  const frame = Buffer.alloc(8);
  body.copy(frame, 0);
  frame.writeUInt16LE(crc, 6);
  return frame;
}

export interface ParsedResponse {
  slave: number;
  functionCode: number;
  exception?: number;
  data?: Buffer; // register payload bytes (after byte-count)
}

export function parseResponse(frame: Buffer): ParsedResponse | null {
  if (frame.length < 5) return null;
  const body = frame.subarray(0, frame.length - 2);
  const expectedCrc = frame.readUInt16LE(frame.length - 2);
  if (crc16(body) !== expectedCrc) return null;

  const slave = frame.readUInt8(0);
  const functionCode = frame.readUInt8(1);
  if (functionCode & 0x80) {
    return { slave, functionCode: functionCode & 0x7f, exception: frame.readUInt8(2) };
  }
  const byteCount = frame.readUInt8(2);
  if (frame.length < 3 + byteCount + 2) return null;
  return { slave, functionCode, data: frame.subarray(3, 3 + byteCount) };
}

function wordsOf(type: RegisterDef["type"]): number {
  return type === "float32" || type === "u32" || type === "i32" ? 2 : 1;
}

// Span of registers needed to cover a map, capped to Modbus' 125-register limit.
export function registerSpan(map: RegisterDef[]): { start: number; quantity: number } | null {
  if (map.length === 0) return null;
  const start = Math.min(...map.map((r) => r.address));
  const end = Math.max(...map.map((r) => r.address + wordsOf(r.type)));
  const quantity = end - start;
  if (quantity > 125) return null;
  return { start, quantity };
}

export function decodeRegisters(
  map: RegisterDef[],
  data: Buffer,
  baseAddress: number,
): Partial<Record<MetricKey, number>> {
  const out: Partial<Record<MetricKey, number>> = {};
  for (const def of map) {
    const offset = (def.address - baseAddress) * 2;
    if (offset < 0 || offset + wordsOf(def.type) * 2 > data.length) continue;
    let raw: number;
    switch (def.type) {
      case "float32":
        raw = data.readFloatBE(offset);
        break;
      case "u32":
        raw = data.readUInt32BE(offset);
        break;
      case "i32":
        raw = data.readInt32BE(offset);
        break;
      case "u16":
        raw = data.readUInt16BE(offset);
        break;
      case "i16":
        raw = data.readInt16BE(offset);
        break;
    }
    if (Number.isFinite(raw)) {
      const v = raw * def.scale;
      out[def.key] = Math.round(v * 10000) / 10000;
    }
  }
  return out;
}
