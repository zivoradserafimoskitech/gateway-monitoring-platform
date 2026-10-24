// FC16 (write multiple holding registers) encoding for control writes.
//
// A BESS setpoint that does not fit one 16-bit register (32-bit power in W,
// float32 setpoints, signed values) needs FC16: several registers written
// atomically in one request. This module turns a scaled setpoint into the
// register words and builds the RTU frame; it does no I/O.
import { crc16 } from "../modbus";

export type RegisterType = "uint16" | "int16" | "uint32" | "int32" | "float32";
export type WordOrder = "big" | "little";

export const REGISTER_COUNT: Record<RegisterType, number> = {
  uint16: 1,
  int16: 1,
  uint32: 2,
  int32: 2,
  float32: 2,
};

/** Max registers in one FC16 request (Modbus spec: 123). */
export const FC16_MAX_REGISTERS = 123;

export class EncodeError extends Error {}

/**
 * Encode an already-scaled value into register words. Integers must fit the
 * type's range (no silent wrap: a wrapped power setpoint changes sign).
 * wordOrder "big" = high word first (Modbus convention), "little" = swapped.
 */
export function encodeRegisters(raw: number, type: RegisterType, wordOrder: WordOrder = "big"): number[] {
  if (!Number.isFinite(raw)) throw new EncodeError("value is not finite");
  const buf = Buffer.alloc(4);
  let words: number[];
  switch (type) {
    case "uint16":
      if (!Number.isInteger(raw) || raw < 0 || raw > 0xffff) throw new EncodeError(`${raw} does not fit uint16`);
      return [raw];
    case "int16":
      if (!Number.isInteger(raw) || raw < -0x8000 || raw > 0x7fff) throw new EncodeError(`${raw} does not fit int16`);
      return [raw & 0xffff];
    case "uint32":
      if (!Number.isInteger(raw) || raw < 0 || raw > 0xffffffff) throw new EncodeError(`${raw} does not fit uint32`);
      buf.writeUInt32BE(raw, 0);
      break;
    case "int32":
      if (!Number.isInteger(raw) || raw < -0x80000000 || raw > 0x7fffffff) throw new EncodeError(`${raw} does not fit int32`);
      buf.writeInt32BE(raw, 0);
      break;
    case "float32":
      buf.writeFloatBE(raw, 0);
      break;
  }
  words = [buf.readUInt16BE(0), buf.readUInt16BE(2)];
  if (wordOrder === "little") words = words.reverse();
  return words;
}

/** Inverse of encodeRegisters (used for read-back comparison and display). */
export function decodeRegisters(words: number[], type: RegisterType, wordOrder: WordOrder = "big"): number {
  if (words.length < REGISTER_COUNT[type]) throw new EncodeError("not enough registers");
  if (type === "uint16") return words[0];
  if (type === "int16") return words[0] >= 0x8000 ? words[0] - 0x10000 : words[0];
  const w = wordOrder === "little" ? [words[1], words[0]] : [words[0], words[1]];
  const buf = Buffer.alloc(4);
  buf.writeUInt16BE(w[0], 0);
  buf.writeUInt16BE(w[1], 2);
  if (type === "uint32") return buf.readUInt32BE(0);
  if (type === "int32") return buf.readInt32BE(0);
  return buf.readFloatBE(0);
}

/** FC16 RTU frame: slave, 0x10, addr, qty, byteCount, data..., CRC (LE). */
export function buildWriteMultipleRequest(slave: number, address: number, words: number[]): Buffer {
  if (words.length < 1 || words.length > FC16_MAX_REGISTERS) throw new EncodeError(`FC16 quantity ${words.length} out of range 1..${FC16_MAX_REGISTERS}`);
  const body = Buffer.alloc(7 + words.length * 2);
  body.writeUInt8(slave, 0);
  body.writeUInt8(16, 1);
  body.writeUInt16BE(address, 2);
  body.writeUInt16BE(words.length, 4);
  body.writeUInt8(words.length * 2, 6);
  words.forEach((w, i) => body.writeUInt16BE(w & 0xffff, 7 + i * 2));
  const frame = Buffer.alloc(body.length + 2);
  body.copy(frame, 0);
  frame.writeUInt16LE(crc16(body), body.length);
  return frame;
}

export function wordsEqual(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => (v & 0xffff) === (b[i] & 0xffff));
}
