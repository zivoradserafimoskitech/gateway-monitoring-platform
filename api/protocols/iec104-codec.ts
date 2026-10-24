// IEC 60870-5-104 codec (pure, no I/O).
//
// APCI: 0x68, length, 4 control octets. Frame formats:
//   I  (information): send/receive sequence numbers, carries an ASDU
//   S  (supervisory): acknowledges received I-frames
//   U  (unnumbered):  STARTDT / STOPDT / TESTFR act+con
// ASDU (common profile: COT 2 octets, common address 2 octets, IOA 3 octets):
//   typeId, VSQ (SQ bit + count), COT (cause, P/N, test), ORG, CA, objects.
//
// Supported information types — the ones a PV/BESS RTU actually emits:
//   M_SP_NA_1 (1)  single point          M_DP_NA_1 (3)  double point
//   M_ME_NA_1 (9)  normalised value      M_ME_NB_1 (11) scaled value
//   M_ME_NC_1 (13) short float           M_ME_TF_1 (36) short float + CP56 time
//   M_IT_NA_1 (15) integrated totals (energy counters)
// Commands: C_IC_NA_1 (100) general interrogation, C_SE_NC_1 (50) float
// setpoint, C_SC_NA_1 (45) single command.

export const START = 0x68;

export const TYPE = {
  M_SP_NA_1: 1,
  M_DP_NA_1: 3,
  M_ME_NA_1: 9,
  M_ME_NB_1: 11,
  M_ME_NC_1: 13,
  M_IT_NA_1: 15,
  M_ME_TF_1: 36,
  C_SC_NA_1: 45,
  C_SE_NC_1: 50,
  C_IC_NA_1: 100,
} as const;

export const COT = {
  PERIODIC: 1,
  SPONTANEOUS: 3,
  ACTIVATION: 6,
  ACTIVATION_CON: 7,
  DEACTIVATION: 8,
  ACTIVATION_TERM: 10,
  INTERROGATED: 20,
} as const;

export const U = {
  STARTDT_ACT: 0x07,
  STARTDT_CON: 0x0b,
  STOPDT_ACT: 0x13,
  STOPDT_CON: 0x23,
  TESTFR_ACT: 0x43,
  TESTFR_CON: 0x83,
} as const;

export class Iec104Error extends Error {}

export type Apdu =
  | { kind: "I"; ns: number; nr: number; asdu: Buffer }
  | { kind: "S"; nr: number }
  | { kind: "U"; fn: number };

export function uFrame(fn: number): Buffer {
  return Buffer.from([START, 4, fn, 0, 0, 0]);
}

export function sFrame(nr: number): Buffer {
  return Buffer.from([START, 4, 0x01, 0, (nr << 1) & 0xfe, (nr >> 7) & 0xff]);
}

export function iFrame(ns: number, nr: number, asdu: Buffer): Buffer {
  if (asdu.length > 249) throw new Iec104Error("ASDU too long");
  const h = Buffer.from([START, asdu.length + 4, (ns << 1) & 0xfe, (ns >> 7) & 0xff, (nr << 1) & 0xfe, (nr >> 7) & 0xff]);
  return Buffer.concat([h, asdu]);
}

/**
 * Split a TCP byte stream into APDUs. Returns parsed frames and the
 * unconsumed tail (a partial frame waiting for more bytes).
 */
export function splitApdus(buf: Buffer): { frames: Apdu[]; rest: Buffer } {
  const frames: Apdu[] = [];
  let off = 0;
  while (buf.length - off >= 2) {
    if (buf[off] !== START) throw new Iec104Error(`bad start octet 0x${buf[off].toString(16)} at ${off}`);
    const len = buf[off + 1];
    if (len < 4) throw new Iec104Error(`APDU length ${len} < 4`);
    if (buf.length - off < len + 2) break;
    const c = buf.subarray(off + 2, off + 6);
    if ((c[0] & 0x01) === 0) {
      frames.push({ kind: "I", ns: (c[0] >> 1) | (c[1] << 7), nr: (c[2] >> 1) | (c[3] << 7), asdu: Buffer.from(buf.subarray(off + 6, off + 2 + len)) });
    } else if ((c[0] & 0x03) === 0x01) {
      frames.push({ kind: "S", nr: (c[2] >> 1) | (c[3] << 7) });
    } else {
      frames.push({ kind: "U", fn: c[0] });
    }
    off += len + 2;
  }
  return { frames, rest: Buffer.from(buf.subarray(off)) };
}

function ioaBytes(ioa: number): number[] {
  return [ioa & 0xff, (ioa >> 8) & 0xff, (ioa >> 16) & 0xff];
}

function asduHeader(typeId: number, cot: number, ca: number, count = 1, sq = false, originator = 0): number[] {
  return [typeId, (sq ? 0x80 : 0) | (count & 0x7f), cot & 0x3f, originator & 0xff, ca & 0xff, (ca >> 8) & 0xff];
}

/** C_IC_NA_1 station interrogation (QOI 20). */
export function interrogationAsdu(ca: number, originator = 0): Buffer {
  return Buffer.from([...asduHeader(TYPE.C_IC_NA_1, COT.ACTIVATION, ca, 1, false, originator), 0, 0, 0, 20]);
}

/** C_SE_NC_1 short-float setpoint, direct execute (QOS S/E=0). */
export function floatSetpointAsdu(ca: number, ioa: number, value: number, originator = 0, select = false): Buffer {
  const f = Buffer.alloc(4);
  f.writeFloatLE(value, 0);
  return Buffer.from([...asduHeader(TYPE.C_SE_NC_1, COT.ACTIVATION, ca, 1, false, originator), ...ioaBytes(ioa), ...f, select ? 0x80 : 0x00]);
}

/** C_SC_NA_1 single command (on/off), direct execute. */
export function singleCommandAsdu(ca: number, ioa: number, on: boolean, originator = 0): Buffer {
  return Buffer.from([...asduHeader(TYPE.C_SC_NA_1, COT.ACTIVATION, ca, 1, false, originator), ...ioaBytes(ioa), on ? 1 : 0]);
}

export interface InfoObject {
  ioa: number;
  value: number;
  /** Quality descriptor: true when IV/NT/SB/BL/OV are all clear. */
  good: boolean;
  /** CP56Time2a timestamp (ms since epoch) when the type carries one. */
  time?: number;
}

export interface Asdu {
  typeId: number;
  cot: number;
  negative: boolean;
  test: boolean;
  ca: number;
  objects: InfoObject[];
}

/** Bytes of the information element (excluding IOA) per supported type. */
const ELEMENT_SIZE: Record<number, number> = {
  [TYPE.M_SP_NA_1]: 1,
  [TYPE.M_DP_NA_1]: 1,
  [TYPE.M_ME_NA_1]: 3,
  [TYPE.M_ME_NB_1]: 3,
  [TYPE.M_ME_NC_1]: 5,
  [TYPE.M_IT_NA_1]: 5,
  [TYPE.M_ME_TF_1]: 12,
  [TYPE.C_SC_NA_1]: 1,
  [TYPE.C_SE_NC_1]: 5,
  [TYPE.C_IC_NA_1]: 1,
};

export function cp56ToMs(b: Buffer, o: number): number {
  const ms = b.readUInt16LE(o);
  const min = b[o + 2] & 0x3f;
  const hour = b[o + 3] & 0x1f;
  const day = b[o + 4] & 0x1f;
  const month = (b[o + 5] & 0x0f) - 1;
  const year = 2000 + (b[o + 6] & 0x7f);
  return Date.UTC(year, month, day, hour, min, 0, ms);
}

function element(typeId: number, b: Buffer, o: number): { value: number; good: boolean; time?: number } {
  const qGood = (q: number) => (q & 0xf1) === 0; // IV NT SB BL ... OV
  switch (typeId) {
    case TYPE.M_SP_NA_1:
      return { value: b[o] & 0x01, good: (b[o] & 0xf0) === 0 };
    case TYPE.M_DP_NA_1:
      return { value: b[o] & 0x03, good: (b[o] & 0xf0) === 0 };
    case TYPE.M_ME_NA_1:
      return { value: b.readInt16LE(o) / 32768, good: qGood(b[o + 2]) };
    case TYPE.M_ME_NB_1:
      return { value: b.readInt16LE(o), good: qGood(b[o + 2]) };
    case TYPE.M_ME_NC_1:
      return { value: b.readFloatLE(o), good: qGood(b[o + 4]) };
    case TYPE.M_IT_NA_1:
      return { value: b.readInt32LE(o), good: (b[o + 4] & 0x80) === 0 };
    case TYPE.M_ME_TF_1:
      return { value: b.readFloatLE(o), good: qGood(b[o + 4]), time: cp56ToMs(b, o + 5) };
    case TYPE.C_SE_NC_1:
      return { value: b.readFloatLE(o), good: true };
    case TYPE.C_SC_NA_1:
      return { value: b[o] & 0x01, good: true };
    default:
      return { value: b[o], good: true };
  }
}

export function parseAsdu(b: Buffer): Asdu {
  if (b.length < 6) throw new Iec104Error("ASDU shorter than its header");
  const typeId = b[0];
  const sq = (b[1] & 0x80) !== 0;
  const n = b[1] & 0x7f;
  const cot = b[2] & 0x3f;
  const negative = (b[2] & 0x40) !== 0;
  const test = (b[2] & 0x80) !== 0;
  const ca = b.readUInt16LE(4);
  const size = ELEMENT_SIZE[typeId];
  const objects: InfoObject[] = [];
  if (size === undefined) return { typeId, cot, negative, test, ca, objects };
  let o = 6;
  const readIoa = () => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16);
  if (sq) {
    if (b.length < o + 3 + n * size) throw new Iec104Error("truncated SQ ASDU");
    const base = readIoa();
    o += 3;
    for (let i = 0; i < n; i++, o += size) objects.push({ ioa: base + i, ...element(typeId, b, o) });
  } else {
    if (b.length < o + n * (3 + size)) throw new Iec104Error("truncated ASDU");
    for (let i = 0; i < n; i++) {
      const ioa = readIoa();
      o += 3;
      objects.push({ ioa, ...element(typeId, b, o) });
      o += size;
    }
  }
  return { typeId, cot, negative, test, ca, objects };
}
