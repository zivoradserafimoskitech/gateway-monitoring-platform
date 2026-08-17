// Wave 5 / T2: CSV parser + validation unit tests (no DB, no Modbus).
import { test, expect } from "vitest";
import {
  parseCsvText,
  detectColumnMapping,
  parseProfileCsv,
  validateImportRows,
  rowsToProfileMaps,
  profileMapsToCsv,
  type CsvRegisterRow,
} from "./csv";

const HEADER = "key,address,fc,type,scale,unit,writable,min,max,description";
const VALID_CSV = `${HEADER}
socPercent,13022,3,u16,0.1,%,false,,,Battery SOC
batteryPowerKw,13021,3,i16,0.1,kW,false,,,+ discharge / - charge
activePowerSetpointKw,13051,6,i16,0.1,kW,true,-100,100,Power command`;

test("parseCsvText: quotes, commas inside quotes, CRLF, BOM", () => {
  const text = '﻿a,b\r\n"1,2","say ""hi"""\r\nx,y';
  expect(parseCsvText(text)).toEqual([
    ["a", "b"],
    ["1,2", 'say "hi"'],
    ["x", "y"],
  ]);
});

test("parse: canonical header parses all rows with correct types", () => {
  const r = parseProfileCsv(VALID_CSV);
  expect(r.errors).toEqual([]);
  expect(r.rows).toHaveLength(3);
  expect(r.rows[0]).toMatchObject({ key: "socPercent", address: 13022, fc: 3, type: "u16", scale: 0.1, writable: false });
  expect(r.rows[2]).toMatchObject({ key: "activePowerSetpointKw", fc: 6, writable: true, min: -100, max: 100 });
});

test("mapping: header synonyms are auto-detected", () => {
  const csv = "Name,Register,Function Code,Data Type,Scale Factor,Units,R/W,Min,Max,Comment\n" +
    "socPercent,13022,3,uint16,0.1,%,ro,,,Battery SOC";
  const detected = detectColumnMapping(["Name", "Register", "Function Code", "Data Type", "Scale Factor", "Units", "R/W", "Min", "Max", "Comment"]);
  expect(detected).toMatchObject({ key: "Name", address: "Register", fc: "Function Code", type: "Data Type", scale: "Scale Factor", writable: "R/W" });
  const r = parseProfileCsv(csv);
  expect(r.errors).toEqual([]);
  expect(r.rows[0]).toMatchObject({ key: "socPercent", type: "u16", writable: false });
});

test("mapping: reordered columns parse correctly", () => {
  const csv = "description,scale,address,key,type,fc\nBattery SOC,0.1,13022,socPercent,u16,3";
  const r = parseProfileCsv(csv);
  expect(r.errors).toEqual([]);
  expect(r.rows[0]).toMatchObject({ key: "socPercent", address: 13022, scale: 0.1, fc: 3, description: "Battery SOC" });
});

test("mapping: explicit mapping overrides detection and tolerates unknown headers", () => {
  const csv = "Col A,Col B,Col C,Col D,Col E\nsocPercent,13022,3,u16,0.1";
  const r = parseProfileCsv(csv, { key: "Col A", address: "Col B", fc: "Col C", type: "Col D", scale: "Col E" });
  expect(r.errors).toEqual([]);
  expect(r.rows).toHaveLength(1);
});

test("mapping: missing required column is a file-level error", () => {
  const r = parseProfileCsv("key,address,fc,scale\na,1,3,1");
  expect(r.rows).toEqual([]);
  expect(r.errors.some((e) => e.row === 0 && /missing required column 'type'/.test(e.message))).toBe(true);
});

test("parse: bad rows are reported with line numbers and skipped", () => {
  const csv = `${HEADER}
bad key!,100,3,u16,1,,false,,,
ok1,abc,3,u16,1,,false,,,
ok2,100,9,u16,1,,false,,,
ok3,100,3,bcd,1,,false,,,
ok4,100,3,u16,0,,false,,,
ok5,100,3,u16,1,,maybe,,,`;
  const r = parseProfileCsv(csv);
  expect(r.rows).toEqual([]);
  expect(r.errors.map((e) => e.row)).toEqual([2, 3, 4, 5, 6, 7]);
  expect(r.errors[0].message).toMatch(/invalid key/);
  expect(r.errors[1].message).toMatch(/invalid address/);
  expect(r.errors[2].message).toMatch(/invalid fc/);
  expect(r.errors[3].message).toMatch(/unsupported type/);
  expect(r.errors[4].message).toMatch(/invalid scale/);
  expect(r.errors[5].message).toMatch(/writable/);
});

test("validate: overlapping addresses in the same address space are rejected", () => {
  const mk = (key: string, address: number, fc: 3 | 4, type: CsvRegisterRow["type"], row: number): CsvRegisterRow => ({
    row, key, address, fc, type, scale: 1, unit: "", writable: false, description: "",
  });
  // u32 at 100 covers 100..101; u16 at 101 overlaps.
  const errors = validateImportRows([mk("a", 100, 3, "u32", 2), mk("b", 101, 3, "u16", 3)]);
  expect(errors.some((e) => /overlapping addresses/.test(e.message) && /'a'/.test(e.message) && /'b'/.test(e.message))).toBe(true);
  // Same numeric overlap but DIFFERENT address space (input vs holding) is fine.
  expect(validateImportRows([mk("a", 100, 3, "u32", 2), mk("b", 101, 4, "u16", 3)])).toEqual([]);
  // Adjacent but non-overlapping is fine.
  expect(validateImportRows([mk("a", 100, 3, "u32", 2), mk("b", 102, 3, "u16", 3)])).toEqual([]);
});

test("validate: read row + writable row at the exact same span is the same point exposed twice — allowed", () => {
  const mk = (key: string, address: number, fc: 3 | 6, type: CsvRegisterRow["type"], writable: boolean, row: number): CsvRegisterRow => ({
    row, key, address, fc, type, scale: 1, unit: "", writable,
    ...(writable ? { min: 0, max: 100 } : {}),
    description: "",
  });
  // read-back key + setpoint key on the same register (the sunspec-inverter-103
  // wMaxLimPct / activePowerLimitPct pattern) — not an authoring error.
  expect(validateImportRows([mk("wMaxLimPct", 155, 3, "u16", false, 2), mk("activePowerLimitPct", 155, 6, "u16", true, 3)])).toEqual([]);
  // write+write on the same span is still rejected (two setpoints, one register).
  expect(validateImportRows([mk("w1", 155, 6, "u16", true, 2), mk("w2", 155, 6, "u16", true, 3)]).some((e) => /overlapping addresses/.test(e.message))).toBe(true);
  // read+read on the same span is still rejected.
  expect(validateImportRows([mk("r1", 155, 3, "u16", false, 2), mk("r2", 155, 3, "u16", false, 3)]).some((e) => /overlapping addresses/.test(e.message))).toBe(true);
  // read+write but only PARTIAL overlap (different widths) is still rejected.
  expect(validateImportRows([mk("r", 155, 3, "u32", false, 2), mk("w", 155, 6, "u16", true, 3)]).some((e) => /overlapping addresses/.test(e.message))).toBe(true);
});

test("validate: duplicate keys rejected", () => {
  const rows = parseProfileCsv(`${HEADER}\nsoc,1,3,u16,1,,false,,,\nsoc,2,3,u16,1,,false,,,`);
  const errors = validateImportRows(rows.rows);
  expect(errors.some((e) => /duplicate key 'soc'/.test(e.message))).toBe(true);
});

test("validate: writable row requires BOTH min and max (nameplate limits)", () => {
  const rows = parseProfileCsv(`${HEADER}\nsp,10,6,i16,0.1,kW,true,-100,,Power`);
  expect(rows.errors).toEqual([]);
  const errors = validateImportRows(rows.rows);
  expect(errors).toHaveLength(1);
  expect(errors[0].message).toMatch(/requires BOTH min and max/);
  expect(errors[0].message).toMatch(/NAMEPLATE/);
});

test("validate: min >= max rejected; writable fc4 rejected; write-fc read row rejected", () => {
  const rows = parseProfileCsv(`${HEADER}
a,10,6,i16,1,kW,true,100,-100,x
b,12,4,u16,1,,true,0,10,x
c,14,6,u16,1,,false,,,x`);
  const errors = validateImportRows(rows.rows);
  expect(errors.some((e) => /min \(100\) must be less than max \(-100\)/.test(e.message))).toBe(true);
  expect(errors.some((e) => /input registers \(fc 4\) are read-only/.test(e.message))).toBe(true);
  expect(errors.some((e) => /fc 6 is a write function code/.test(e.message))).toBe(true);
});

test("maps: writable fc6 row goes to controllable only; fc3 writable goes to both; scale inverted", () => {
  const r = parseProfileCsv(VALID_CSV);
  const { registerMap, controllable } = rowsToProfileMaps(r.rows);
  expect(registerMap.map((d) => d.key)).toEqual(["socPercent", "batteryPowerKw"]);
  expect(Object.keys(controllable)).toEqual(["activePowerSetpointKw"]);
  expect(controllable.activePowerSetpointKw).toMatchObject({
    address: 13051, fc: 6, min: -100, max: 100, unit: "kW", description: "Power command",
  });
  // register value = setpoint × controllable scale → inverse of the read scale
  expect(controllable.activePowerSetpointKw.scale).toBeCloseTo(10, 9);

  const both = rowsToProfileMaps(parseProfileCsv(`${HEADER}\nmodeReg,200,3,u16,1,,true,0,2,Operating mode`).rows);
  expect(both.registerMap[0]).toMatchObject({ key: "modeReg", functionCode: 3, min: 0, max: 2 });
  expect(both.controllable.modeReg).toMatchObject({ address: 200, fc: 6, min: 0, max: 2 });
});

test("export → import round-trip preserves keys, addresses, scales and bounds", () => {
  const first = parseProfileCsv(VALID_CSV);
  expect(validateImportRows(first.rows)).toEqual([]);
  const maps = rowsToProfileMaps(first.rows);
  const csvOut = profileMapsToCsv(maps.registerMap, maps.controllable);
  expect(csvOut.split("\n")[0]).toBe(HEADER); // exact canonical header

  const second = parseProfileCsv(csvOut);
  expect(second.errors).toEqual([]);
  expect(validateImportRows(second.rows)).toEqual([]);
  const maps2 = rowsToProfileMaps(second.rows);
  expect(maps2.registerMap).toEqual(maps.registerMap);
  expect(Object.keys(maps2.controllable)).toEqual(Object.keys(maps.controllable));
  for (const [k, c] of Object.entries(maps.controllable)) {
    expect(maps2.controllable[k].address).toBe(c.address);
    expect(maps2.controllable[k].fc).toBe(c.fc);
    expect(maps2.controllable[k].min).toBe(c.min);
    expect(maps2.controllable[k].max).toBe(c.max);
    expect(maps2.controllable[k].scale).toBeCloseTo(c.scale ?? 1, 9);
  }
});

test("export: commas/quotes in description are escaped", () => {
  const csv = profileMapsToCsv(
    [{ key: "soc", label: 'SOC, "main"', address: 1, functionCode: 3, type: "u16", scale: 1, unit: "%" }],
    null,
  );
  expect(csv).toContain('"SOC, ""main"""');
  const back = parseProfileCsv(csv);
  expect(back.rows[0].description).toBe('SOC, "main"');
});
