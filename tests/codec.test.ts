// Unit tests for the Modbus codec extensions (v3) and pure helpers (v5).
import { test } from "vitest";
import assert from "node:assert/strict";
import { shiftedAddress, type RegisterDef } from "../contracts/modbus";
import { decodeRegisters } from "../api/modbus";

test("shiftedAddress: no stride → unchanged", () => {
  const def: RegisterDef = { key: "socPercent", label: "SOC", address: 105, functionCode: 4, type: "u16", scale: 1, unit: "" };
  assert.equal(shiftedAddress(def, 1), 105);
  assert.equal(shiftedAddress(def, 7), 105);
});

test("shiftedAddress: stride applies only at/after firstUnit", () => {
  const def: RegisterDef = {
    key: "socPercent",
    label: "SOC",
    address: 105,
    functionCode: 4,
    type: "u16",
    scale: 1,
    unit: "",
    addressStride: { firstUnit: 2, stride: 3000 },
  };
  assert.equal(shiftedAddress(def, 1), 105); // before firstUnit: untouched
  assert.equal(shiftedAddress(def, 2), 105); // first string: base
  assert.equal(shiftedAddress(def, 3), 3105); // second string: +3000
  assert.equal(shiftedAddress(def, 21), 57105); // 20th string: +19*3000
});

test("decodeRegisters: offset (biased register) applied after scale", () => {
  // ESMU stack current: 0.1 A/bit with -1600 A bias
  const defs: RegisterDef[] = [
    { key: "batteryCurrentA", label: "I", address: 10, functionCode: 4, type: "u16", scale: 0.1, offset: -1600, unit: "A" },
  ];
  const buf = Buffer.alloc(24);
  buf.writeUInt16BE(18960, 20); // raw 18960 → 1896 - 1600 = 296 A
  const values = decodeRegisters(defs, buf, 0);
  assert.ok(Math.abs(values.batteryCurrentA - 296) < 1e-9);
});

test("decodeRegisters: u32 is high-word first", () => {
  const defs: RegisterDef[] = [
    { key: "energyTotalKwh", label: "E", address: 4, functionCode: 4, type: "u32", scale: 0.1, unit: "kWh" },
  ];
  const buf = Buffer.alloc(12);
  buf.writeUInt16BE(0x0001, 8); // high word
  buf.writeUInt16BE(0x0000, 10); // low word → 65536 * 0.1 = 6553.6
  const values = decodeRegisters(defs, buf, 0);
  assert.ok(Math.abs(values.energyTotalKwh - 6553.6) < 1e-9);
});
