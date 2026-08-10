// Unit tests for the CSV export guard (v4 F-08, extracted v5 #23).
import { test } from "vitest";
import assert from "node:assert/strict";
import { csvCell } from "../src/lib/csv";

test("csvCell: formula-leading cells are quote-prefixed", () => {
  assert.equal(csvCell("=CMD|'/c calc'!A1"), "'=CMD|'/c calc'!A1");
  assert.equal(csvCell("+1234"), "'+1234");
  assert.equal(csvCell("-5"), "'-5");
  assert.equal(csvCell("@SUM(A1)"), "'@SUM(A1)");
});

test("csvCell: RFC-4180 quoting for commas, quotes, newlines", () => {
  assert.equal(csvCell('a,b'), '"a,b"');
  assert.equal(csvCell('say "hi"'), '"say ""hi"""');
  assert.equal(csvCell("line1\nline2"), '"line1\nline2"');
});

test("csvCell: plain values and nulls", () => {
  assert.equal(csvCell("Meter 1"), "Meter 1");
  assert.equal(csvCell(42.5), "42.5");
  assert.equal(csvCell(null), "");
  assert.equal(csvCell(undefined), "");
});

test("csvCell: injection AND quoting compose", () => {
  // starts with '=' AND contains a comma → prefix + quote
  assert.equal(csvCell("=1,2"), `"'=1,2"`);
});
