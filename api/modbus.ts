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

// ─── Read-block planning (shared by the TCP poller and the C30 path) ────────
// Moved out of api/poller/service.ts (Wave 4 / C30 T2): the C30 transparent
// channel needs the same block list — both to issue one read request per block
// (profiles wider than the 125-register span limit) and to attribute
// unsolicited response frames to a block by byte count.
export const MAX_BLOCK_WORDS = 120; // Modbus spec limit is 125 registers per read
export const MAX_GAP_WORDS = 8;

export interface Block {
  functionCode: 3 | 4;
  start: number; // PDU address
  words: number;
  defs: RegisterDef[];
}

// Group a register map into minimal read blocks.
export function buildBlocks(map: RegisterDef[]): Block[] {
  const wordsOfT = (t: RegisterDef["type"]) => (t === "float32" || t === "u32" || t === "i32" ? 2 : 1);
  const blocks: Block[] = [];
  for (const fc of [3, 4] as const) {
    const defs = map
      .filter((d) => d.functionCode === fc)
      .sort((a, b) => a.address - b.address);
    let cur: Block | null = null;
    for (const def of defs) {
      const w = wordsOfT(def.type);
      const end = def.address + w;
      if (cur && def.address - (cur.start + cur.words) <= MAX_GAP_WORDS && end - cur.start <= MAX_BLOCK_WORDS) {
        cur.words = end - cur.start;
        cur.defs.push(def);
      } else {
        cur = { functionCode: fc, start: def.address, words: w, defs: [def] };
        blocks.push(cur);
      }
    }
  }
  return blocks;
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

export interface DecodeResult {
  values: Record<string, number>;
  // Values that decoded fine but fell outside the register's declared min/max
  // plausibility bounds (Wave 4 / C30 T3) — NOT emitted into `values`, so they
  // never reach persistTelemetry; callers count them (telemetry_values_rejected_total).
  rejected: Array<{ key: string; value: number }>;
}

/**
 * Decode the RAW (unscaled) value of one register def out of a read-block
 * buffer. Extracted from decodeRegisters (Wave 5 / T2) so the profile-import
 * preview can show raw next to scaled — a wrong scale is obvious when
 * socPercent reads 6553.5. Task 3's bench verification polls keys the same way.
 */
export function decodeRawValue(def: RegisterDef, data: Buffer, baseAddress: number): number | undefined {
  const size = wordsOf(def.type) * 2;
  const offset = (def.address - baseAddress) * 2;
  if (offset < 0 || offset + size > data.length) return undefined;
  const view = def.wordSwap && size === 4 ? swapWords(data, offset, size) : data;
  const off = def.wordSwap && size === 4 ? 0 : offset;
  switch (def.type) {
    case "float32":
      return view.readFloatBE(off);
    case "u32":
      return view.readUInt32BE(off);
    case "i32":
      return view.readInt32BE(off);
    case "u16":
      return view.readUInt16BE(off);
    case "i16":
      return view.readInt16BE(off);
  }
}

export function decodeRegisters(
  map: RegisterDef[],
  data: Buffer,
  baseAddress: number,
): DecodeResult {
  const out: Record<string, number> = {};
  const rejected: Array<{ key: string; value: number }> = [];
  for (const def of map) {
    const raw = decodeRawValue(def, data, baseAddress);
    if (raw !== undefined && Number.isFinite(raw)) {
      const v = Math.round((raw * def.scale + (def.offset ?? 0)) * 10000) / 10000;
      if ((def.min !== undefined && v < def.min) || (def.max !== undefined && v > def.max)) {
        rejected.push({ key: def.key, value: v });
        continue;
      }
      out[def.key] = v;
    }
  }
  return { values: out, rejected };
}
