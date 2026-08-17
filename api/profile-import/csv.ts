// Wave 5 / T2: CSV import/export for device profiles.
//
// Vendor manuals publish register maps as tables; this module turns a CSV of
// that table into a validated registerMap + controllable whitelist pair —
// adding a vendor becomes a data-entry task, not a code change.
//
// Canonical CSV shape (export writes exactly this header):
//   key,address,fc,type,scale,unit,writable,min,max,description
//
// - `fc` is 3|4 for read rows, 6|16 for write-only rows. A writable row with
//   fc 3 is a holding register that is BOTH readable and writable: it lands in
//   registerMap (fc 3) AND in the controllable whitelist (written via FC6).
// - `scale` means value = raw × scale (same as RegisterDef.scale). The
//   controllable whitelist stores the INVERSE (register value = setpoint ×
//   ControllableDef.scale), so export divides and import inverts — round-trip
//   is scale-exact within float precision.
// - min/max on writable rows are NAMEPLATE limits (constraint #4), never the
//   register's theoretical range — both are REQUIRED on writable rows.
import type { RegisterDef, RegisterType } from "@contracts/modbus";
import type { ControllableMap } from "../control/execute";

export const CANONICAL_COLUMNS = [
  "key",
  "address",
  "fc",
  "type",
  "scale",
  "unit",
  "writable",
  "min",
  "max",
  "description",
] as const;
export type CanonicalColumn = (typeof CANONICAL_COLUMNS)[number];

// Vendor spreadsheets rarely use our exact headers. Synonyms are matched after
// normalising (lowercase, strip spaces/underscores/dashes/dots).
const HEADER_SYNONYMS: Record<CanonicalColumn, string[]> = {
  key: ["key", "name", "metric", "field", "signal", "parameter", "tag"],
  address: ["address", "addr", "register", "reg", "registeraddress", "startaddress", "regno", "registerno"],
  fc: ["fc", "function", "functioncode", "funccode", "fccode"],
  type: ["type", "datatype", "format", "wordtype", "valuetype"],
  scale: ["scale", "scalefactor", "factor", "multiplier", "gain", "resolution"],
  unit: ["unit", "units", "uom", "unitofmeasure"],
  writable: ["writable", "writeable", "write", "rw", "access", "mode"],
  min: ["min", "minimum", "minvalue", "low", "lowerlimit", "rangemin"],
  max: ["max", "maximum", "maxvalue", "high", "upperlimit", "rangemax"],
  description: ["description", "desc", "label", "comment", "comments", "notes", "note", "text"],
};

// Columns a usable map cannot do without. unit/writable/min/max/description
// may be absent (empty cells then apply: unit="", writable=false, no bounds).
const REQUIRED_COLUMNS: CanonicalColumn[] = ["key", "address", "fc", "type", "scale"];

export type ColumnMapping = Partial<Record<CanonicalColumn, string>>;

export interface CsvRegisterRow {
  row: number; // 1-based CSV line number (header line = 1)
  key: string;
  address: number;
  fc: 3 | 4 | 6 | 16;
  type: RegisterType;
  scale: number;
  unit: string;
  writable: boolean;
  min?: number;
  max?: number;
  description: string;
}

export interface ImportError {
  row: number; // 0 = whole-file error (header/columns)
  message: string;
}

// ─── Raw CSV text → string matrix (RFC-4180-ish: quotes, commas, CRLF) ──────
export function parseCsvText(text: string): string[][] {
  const rows: string[][] = [];
  let field = "";
  let row: string[] = [];
  let inQuotes = false;
  let i = 0;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push(row);
    row = [];
  };
  // Strip a BOM if present.
  if (text.charCodeAt(0) === 0xfeff) i = 1;
  for (; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ",") {
      pushField();
    } else if (c === "\n") {
      pushRow();
    } else if (c === "\r") {
      // handled by the \n branch (or ignored for a lone-CR file)
    } else {
      field += c;
    }
  }
  // Last row (file not ending in newline)
  if (field.length > 0 || row.length > 0) pushRow();
  // Drop fully-empty trailing/blank lines
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[\s_\-./()]+/g, "");
}

/** Auto-detect a canonical-column → spreadsheet-header mapping. */
export function detectColumnMapping(headers: string[]): ColumnMapping {
  const mapping: ColumnMapping = {};
  const used = new Set<string>();
  for (const col of CANONICAL_COLUMNS) {
    const wanted = new Set([col, ...HEADER_SYNONYMS[col]].map(normalizeHeader));
    for (const h of headers) {
      if (used.has(h)) continue;
      if (wanted.has(normalizeHeader(h))) {
        mapping[col] = h;
        used.add(h);
        break;
      }
    }
  }
  return mapping;
}

const TYPE_SYNONYMS: Record<string, RegisterType> = {
  u16: "u16",
  uint16: "u16",
  uint: "u16",
  word: "u16",
  unsigned16: "u16",
  i16: "i16",
  int16: "i16",
  int: "i16",
  short: "i16",
  signed16: "i16",
  u32: "u32",
  uint32: "u32",
  dword: "u32",
  unsigned32: "u32",
  i32: "i32",
  int32: "i32",
  long: "i32",
  signed32: "i32",
  float32: "float32",
  float: "float32",
  f32: "float32",
  real: "float32",
  ieee754: "float32",
};

const WRITABLE_TRUE = new Set(["true", "yes", "y", "1", "w", "rw", "write", "writable", "readwrite"]);
const WRITABLE_FALSE = new Set(["", "false", "no", "n", "0", "r", "ro", "read", "readonly", "read only"]);

function parseFc(raw: string): 3 | 4 | 6 | 16 | null {
  const digits = raw.toLowerCase().replace(/^(fc|0x)/, "").replace(/[^0-9].*$/, "");
  const n = Number(digits);
  return n === 3 || n === 4 || n === 6 || n === 16 ? n : null;
}

function parseNum(raw: string): number | null {
  const t = raw.trim();
  if (t === "") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

export interface ParseResult {
  headers: string[];
  mapping: ColumnMapping; // resolved mapping actually used (detect + overrides)
  rows: CsvRegisterRow[];
  errors: ImportError[];
}

/**
 * Parse CSV text into typed register rows. `mapping` overrides auto-detection;
 * any canonical column not present in `mapping` is auto-detected from headers.
 * Row-level problems (bad address/type/fc/…) are collected in `errors` and the
 * offending row is skipped, so the preview shows every problem at once.
 */
export function parseProfileCsv(text: string, mapping: ColumnMapping = {}): ParseResult {
  const errors: ImportError[] = [];
  const matrix = parseCsvText(text);
  if (matrix.length < 2) {
    return { headers: matrix[0] ?? [], mapping, rows: [], errors: [{ row: 0, message: "CSV has no data rows" }] };
  }
  const headers = matrix[0].map((h) => h.trim());
  const resolved: ColumnMapping = { ...detectColumnMapping(headers), ...mapping };
  const colIndex = (col: CanonicalColumn): number => {
    const h = resolved[col];
    return h === undefined ? -1 : headers.indexOf(h);
  };
  for (const col of REQUIRED_COLUMNS) {
    if (colIndex(col) === -1) {
      errors.push({ row: 0, message: `missing required column '${col}' (no header matched; map it explicitly)` });
    }
  }
  if (errors.length > 0) return { headers, mapping: resolved, rows: [], errors };

  const idx = {
    key: colIndex("key"),
    address: colIndex("address"),
    fc: colIndex("fc"),
    type: colIndex("type"),
    scale: colIndex("scale"),
    unit: colIndex("unit"),
    writable: colIndex("writable"),
    min: colIndex("min"),
    max: colIndex("max"),
    description: colIndex("description"),
  };
  const cell = (fields: string[], i: number): string => (i === -1 ? "" : (fields[i] ?? "").trim());

  const rows: CsvRegisterRow[] = [];
  matrix.slice(1).forEach((fields, n) => {
    const rowNo = n + 2; // header is line 1
    const fail = (message: string) => errors.push({ row: rowNo, message });

    const key = cell(fields, idx.key);
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) {
      fail(`invalid key '${key}' (must start with a letter; letters, digits, underscore; max 64 chars)`);
      return;
    }
    const address = parseNum(cell(fields, idx.address));
    if (address === null || !Number.isInteger(address) || address < 0 || address > 65535) {
      fail(`row '${key}': invalid address '${cell(fields, idx.address)}' (integer 0..65535)`);
      return;
    }
    const fc = parseFc(cell(fields, idx.fc));
    if (fc === null) {
      fail(`row '${key}': invalid fc '${cell(fields, idx.fc)}' (3, 4, 6 or 16)`);
      return;
    }
    const type = TYPE_SYNONYMS[normalizeHeader(cell(fields, idx.type))];
    if (!type) {
      fail(
        `row '${key}': unsupported type '${cell(fields, idx.type)}' (supported: float32, u32, i32, u16, i16)`,
      );
      return;
    }
    const scale = parseNum(cell(fields, idx.scale));
    if (scale === null || scale === 0) {
      fail(`row '${key}': invalid scale '${cell(fields, idx.scale)}' (non-zero number; value = raw × scale)`);
      return;
    }
    const writableRaw = normalizeHeader(cell(fields, idx.writable));
    let writable = false;
    if (WRITABLE_TRUE.has(writableRaw)) writable = true;
    else if (!WRITABLE_FALSE.has(writableRaw)) {
      fail(`row '${key}': unrecognised writable value '${cell(fields, idx.writable)}' (true/false, rw/ro, …)`);
      return;
    }
    const minRaw = cell(fields, idx.min);
    const maxRaw = cell(fields, idx.max);
    const min = minRaw === "" ? undefined : parseNum(minRaw);
    const max = maxRaw === "" ? undefined : parseNum(maxRaw);
    if (minRaw !== "" && min === null) {
      fail(`row '${key}': invalid min '${minRaw}'`);
      return;
    }
    if (maxRaw !== "" && max === null) {
      fail(`row '${key}': invalid max '${maxRaw}'`);
      return;
    }
    rows.push({
      row: rowNo,
      key,
      address,
      fc,
      type,
      scale,
      unit: cell(fields, idx.unit),
      writable,
      min: min ?? undefined,
      max: max ?? undefined,
      description: cell(fields, idx.description),
    });
  });
  return { headers, mapping: resolved, rows, errors };
}

// ─── Cross-row + safety validation ──────────────────────────────────────────
function wordsOfType(t: RegisterType): number {
  return t === "float32" || t === "u32" || t === "i32" ? 2 : 1;
}

/**
 * Validation rules for an import (applied after parse; a row with parse errors
 * is already excluded). Any error rejects the WHOLE import — a partially wrong
 * register map is worse than none.
 */
export function validateImportRows(rows: CsvRegisterRow[]): ImportError[] {
  const errors: ImportError[] = [];
  const byKey = new Map<string, CsvRegisterRow>();
  for (const r of rows) {
    const dup = byKey.get(r.key);
    if (dup) {
      errors.push({ row: r.row, message: `duplicate key '${r.key}' (first defined on line ${dup.row})` });
      continue;
    }
    byKey.set(r.key, r);

    if (r.writable) {
      if (r.fc === 4) {
        errors.push({ row: r.row, message: `row '${r.key}': input registers (fc 4) are read-only — cannot be writable` });
      }
      // Constraint #4: writable bounds are the NAMEPLATE limits the control
      // path clamps against — never the register's theoretical range.
      if (r.min === undefined || r.max === undefined) {
        errors.push({
          row: r.row,
          message:
            `writable row '${r.key}' requires BOTH min and max — these are NAMEPLATE limits ` +
            `(e.g. ± rated power) that the control path clamps against, not the register's theoretical range`,
        });
      }
    } else if (r.fc === 6 || r.fc === 16) {
      errors.push({ row: r.row, message: `row '${r.key}': fc ${r.fc} is a write function code — mark the row writable=true` });
    }
    if (r.min !== undefined && r.max !== undefined && r.min >= r.max) {
      errors.push({ row: r.row, message: `row '${r.key}': min (${r.min}) must be less than max (${r.max})` });
    }
    if (r.address + wordsOfType(r.type) - 1 > 65535) {
      errors.push({ row: r.row, message: `row '${r.key}': address + type width exceeds 65535` });
    }
  }

  // No overlapping addresses within the same address space. Holding registers
  // (fc 3) and write targets (fc 6/16) share one space; input (fc 4) is separate.
  const space = (r: CsvRegisterRow): string => (r.fc === 4 ? "input" : "holding");
  const sorted = [...rows].sort((a, b) => a.address - b.address);
  for (let i = 0; i < sorted.length; i++) {
    const a = sorted[i];
    const aEnd = a.address + wordsOfType(a.type) - 1;
    for (let j = i + 1; j < sorted.length; j++) {
      const b = sorted[j];
      if (b.address > aEnd) break;
      if (space(a) !== space(b)) continue;
      if (a.key === b.key) continue; // duplicate key already reported
      // A read row and a writable row spanning the exact same registers are the
      // same point exposed twice (e.g. a setpoint read-back key next to its
      // controllable key under a different name) — legitimate, not an overlap.
      const sameSpan = a.address === b.address && wordsOfType(a.type) === wordsOfType(b.type);
      if (sameSpan && a.writable !== b.writable) continue;
      errors.push({
        row: b.row,
        message:
          `overlapping addresses: '${a.key}' (line ${a.row}, ${space(a)} ${a.address}..${aEnd}) ` +
          `overlaps '${b.key}' (${b.address}..${b.address + wordsOfType(b.type) - 1})`,
      });
    }
  }
  return errors;
}

// ─── Rows → device_profiles maps ────────────────────────────────────────────
const invertScale = (s: number): number => Number((1 / s).toPrecision(12));

/**
 * Split validated rows into the registerMap (reads) and the controllable
 * whitelist (writes — the exact shape executeControl enforces).
 */
export function rowsToProfileMaps(rows: CsvRegisterRow[]): { registerMap: RegisterDef[]; controllable: ControllableMap } {
  const registerMap: RegisterDef[] = [];
  const controllable: ControllableMap = {};
  for (const r of rows) {
    if (r.writable) {
      controllable[r.key] = {
        address: r.address,
        fc: r.fc === 16 ? 16 : 6, // a readable holding register (fc 3) is written via FC6; fc 4 writable is rejected by validation
        min: r.min as number,
        max: r.max as number,
        scale: invertScale(r.scale),
        unit: r.unit || undefined,
        description: r.description || undefined,
      };
      // fc 6/16 write-only rows are not readable through the telemetry path.
      if (r.fc !== 3) continue;
    }
    registerMap.push({
      key: r.key,
      label: r.description || r.key,
      address: r.address,
      functionCode: r.fc as 3 | 4,
      type: r.type,
      scale: r.scale,
      unit: r.unit,
      ...(r.min !== undefined ? { min: r.min } : {}),
      ...(r.max !== undefined ? { max: r.max } : {}),
    });
  }
  return { registerMap, controllable };
}

// ─── Export: device_profiles maps → canonical CSV text ──────────────────────
function csvEscape(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const restoreScale = (s: number): number => Number((1 / s).toPrecision(12));

/**
 * Flatten a profile back to the canonical CSV. Controllable keys become
 * writable=true rows; a key present in BOTH maps exports as a single writable
 * fc-3 row (the readable holding register case).
 */
export function profileMapsToCsv(registerMap: RegisterDef[], controllable: ControllableMap | null | undefined): string {
  const lines: string[] = [CANONICAL_COLUMNS.join(",")];
  const emitted = new Set<string>();
  for (const d of registerMap) {
    const c = controllable?.[d.key];
    emitted.add(d.key);
    lines.push(
      [
        csvEscape(d.key),
        String(d.address),
        String(d.functionCode),
        d.type,
        String(d.scale),
        csvEscape(d.unit ?? ""),
        c ? "true" : "false",
        c ? String(c.min) : (d.min !== undefined ? String(d.min) : ""),
        c ? String(c.max) : (d.max !== undefined ? String(d.max) : ""),
        csvEscape(c?.description ?? d.label ?? ""),
      ].join(","),
    );
  }
  for (const [key, c] of Object.entries(controllable ?? {})) {
    if (emitted.has(key)) continue;
    lines.push(
      [
        csvEscape(key),
        String(c.address),
        String(c.fc ?? 6),
        "i16", // controllable defs carry no register type; writes are 16-bit
        String(restoreScale(c.scale ?? 1)),
        csvEscape(c.unit ?? ""),
        "true",
        String(c.min),
        String(c.max),
        csvEscape(c.description ?? ""),
      ].join(","),
    );
  }
  return lines.join("\n") + "\n";
}
