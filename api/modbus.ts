// Minimal Modbus RTU codec for the C30 transparent channel.
// Frames travel as raw binary inside MQTT payloads (d2g/{uid} up, g2d/{uid} down).
import type { RegisterDef } from "@contracts/modbus";

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

// Reverses 16-bit word ORDER within a field: [w0,w1] -> [w1,w0] (CDAB -> ABCD).
function swapWords(buf: Buffer, offset: number, size: number): Buffer {
  const out = Buffer.alloc(size);
  const words = size / 2;
  for (let w = 0; w < words; w++) {
    buf.copy(out, w * 2, offset + (words - 1 - w) * 2, offset + (words - w) * 2);
  }
  return out;
}

export function decodeRegisters(
  map: RegisterDef[],
  data: Buffer,
  baseAddress: number,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const def of map) {
    const size = wordsOf(def.type) * 2;
    const offset = (def.address - baseAddress) * 2;
    if (offset < 0 || offset + size > data.length) continue;
    const view = def.wordSwap && size === 4 ? swapWords(data, offset, size) : data;
    const off = def.wordSwap && size === 4 ? 0 : offset;
    let raw: number;
    switch (def.type) {
      case "float32":
        raw = view.readFloatBE(off);
        break;
      case "u32":
        raw = view.readUInt32BE(off);
        break;
      case "i32":
        raw = view.readInt32BE(off);
        break;
      case "u16":
        raw = view.readUInt16BE(off);
        break;
      case "i16":
        raw = view.readInt16BE(off);
        break;
    }
    if (Number.isFinite(raw)) {
      const v = raw * def.scale + (def.offset ?? 0);
      out[def.key] = Math.round(v * 10000) / 10000;
    }
  }
  return out;
}
