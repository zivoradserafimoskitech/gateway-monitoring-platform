import { describe, expect, it } from "vitest";
import { buildWriteMultipleRequest, decodeRegisters, encodeRegisters, EncodeError, wordsEqual } from "./registers";
import { crc16 } from "../modbus";

describe("FC16 register encoding", () => {
  it("encodes 32-bit integers high word first, or swapped", () => {
    expect(encodeRegisters(100000, "uint32")).toEqual([0x0001, 0x86a0]);
    expect(encodeRegisters(100000, "uint32", "little")).toEqual([0x86a0, 0x0001]);
    expect(encodeRegisters(-1, "int32")).toEqual([0xffff, 0xffff]);
    expect(encodeRegisters(-5, "int16")).toEqual([0xfffb]);
  });
  it("round-trips every type", () => {
    for (const [v, t] of [[65535, "uint16"], [-300, "int16"], [4e9, "uint32"], [-2e9, "int32"], [12.5, "float32"]] as const) {
      expect(decodeRegisters(encodeRegisters(v, t, "little"), t, "little")).toBeCloseTo(v);
    }
  });
  it("refuses values that would wrap", () => {
    expect(() => encodeRegisters(70000, "uint16")).toThrow(EncodeError);
    expect(() => encodeRegisters(-1, "uint32")).toThrow(EncodeError);
    expect(() => encodeRegisters(3e9, "int32")).toThrow(EncodeError);
    expect(() => encodeRegisters(1.5, "int32")).toThrow(EncodeError);
  });
  it("builds a valid FC16 frame", () => {
    const f = buildWriteMultipleRequest(1, 0x0100, [0x0001, 0x86a0]);
    expect([...f.subarray(0, 11)]).toEqual([1, 0x10, 0x01, 0x00, 0, 2, 4, 0x00, 0x01, 0x86, 0xa0]);
    expect(f.readUInt16LE(11)).toBe(crc16(f.subarray(0, 11)));
    expect(() => buildWriteMultipleRequest(1, 0, [])).toThrow();
  });
  it("compares words", () => {
    expect(wordsEqual([1, 2], [1, 2])).toBe(true);
    expect(wordsEqual([1, 2], [1])).toBe(false);
  });
});
