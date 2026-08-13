// v8/D3: report file generation (xlsx via the `exceljs` package — audit P1-8,
// SheetJS `xlsx@0.18.5` carries unpatched CVEs; pdf via a small hand-rolled
// writer — no headless-browser deps). Output lands in data/reports/
// (REPORT_OUT_DIR override).
import fs from "node:fs";
import path from "node:path";
import ExcelJS from "exceljs";
import type { EnergyReport } from "./energy-query";

export interface GeneratedReport {
  path: string;
  bytes: number;
  filename: string;
}

export function reportOutDir(): string {
  const dir = process.env.REPORT_OUT_DIR || path.join(process.cwd(), "data", "reports");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const fmtN = (n: number | null | undefined, digits = 1): string => (n === null || n === undefined ? "" : n.toFixed(digits));

/** Table rows shared by both formats. */
function tableRows(report: EnergyReport): string[][] {
  const rows: string[][] = [["Device", "Day", "Import kWh", "Export kWh", "Max demand kW", "Avg PF", "Samples"]];
  for (const m of report.meters) {
    for (const d of m.days) {
      rows.push([
        m.meter.name,
        d.day,
        fmtN(d.importKwh, 2) + (d.counterReset ? " (est)" : ""),
        fmtN(d.exportKwh, 2),
        fmtN(d.maxDemandKw, 2) + (d.demandDerived ? " (derived)" : ""),
        fmtN(d.avgPowerFactor, 3),
        String(d.samples),
      ]);
    }
    rows.push([m.meter.name, "TOTAL", m.totalImportKwh.toFixed(2), m.totalExportKwh.toFixed(2), m.maxDemandKw.toFixed(2), "", ""]);
  }
  rows.push(["ALL DEVICES", "TOTAL", report.totalImportKwh.toFixed(2), report.totalExportKwh.toFixed(2), "", "", ""]);
  return rows;
}

function headerLines(report: EnergyReport, title: string, periodLabel: string): string[][] {
  return [
    [title],
    [`Scope: ${report.scopeLabel}`],
    [`Period: ${periodLabel}`],
    [`Generated: ${new Date().toISOString()}`],
    [],
  ];
}

// ─── XLSX (exceljs) ──────────────────────────────────────────────────────────
// Same output format as the old SheetJS build: sheet "Energy", header lines,
// then the table rows — all cells written as strings (no date/number typing),
// so no timezone surprises from mysql2 Date values. SheetJS `wch` and exceljs
// column `width` use the same character-width unit, so widths map 1:1.
async function buildXlsx(report: EnergyReport, title: string, periodLabel: string): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Energy");
  ws.columns = [{ width: 28 }, { width: 12 }, { width: 12 }, { width: 12 }, { width: 14 }, { width: 8 }, { width: 8 }];
  for (const row of [...headerLines(report, title, periodLabel), ...tableRows(report)]) {
    ws.addRow(row); // [] → empty spacer row, same as aoa_to_sheet
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ─── PDF (hand-rolled, single Helvetica font, plain-text table) ─────────────
function pdfEscape(s: string): string {
  // Latin-1 approximation: PDF standard fonts are WinAnsi; replace anything
  // outside printable ASCII to keep the content stream valid.
  return s.replace(/[^\x20-\x7e]/g, "?").replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function buildPdf(lines: string[]): Buffer {
  const perPage = 48;
  const pages: string[][] = [];
  for (let i = 0; i < lines.length; i += perPage) pages.push(lines.slice(i, i + perPage));
  if (pages.length === 0) pages.push(["(empty report)"]);

  const objects: string[] = [];
  const contentIds: number[] = [];
  // 1 catalog, 2 pages, 3 font; then per page: page obj + content stream
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>";
  const pageIds: number[] = [];
  let nextId = 4;
  const contentStreams: { id: number; stream: string }[] = [];
  for (const pageLines of pages) {
    const pageId = nextId++;
    const contentId = nextId++;
    pageIds.push(pageId);
    contentIds.push(contentId);
    let y = 800;
    const cmds = ["BT", "/F1 9 Tf", "14 TL"];
    for (const line of pageLines) {
      cmds.push(`1 0 0 1 40 ${y} Tm (${pdfEscape(line)}) Tj`);
      y -= 14;
    }
    cmds.push("ET");
    contentStreams.push({ id: contentId, stream: cmds.join("\n") });
    objects[pageId] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${contentId} 0 R >>`;
  }
  objects[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${pageIds.length} >>`;
  for (const cs of contentStreams) {
    objects[cs.id] = `<< /Length ${Buffer.byteLength(cs.stream, "latin1")} >>\nstream\n${cs.stream}\nendstream`;
  }
  void contentIds;

  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  const maxId = nextId - 1;
  for (let i = 1; i <= maxId; i++) {
    offsets[i] = Buffer.byteLength(out, "latin1");
    out += `${i} 0 obj\n${objects[i] ?? "<<>>"}\nendobj\n`;
  }
  const xrefPos = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${maxId + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= maxId; i++) out += `${String(offsets[i]).padStart(10, "0")} 00000 n \n`;
  out += `trailer\n<< /Size ${maxId + 1} /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const COL_W = [26, 12, 12, 12, 13, 8, 7];
function tableLine(cols: string[]): string {
  return cols.map((c, i) => (c ?? "").slice(0, COL_W[i]).padEnd(COL_W[i])).join(" ").trimEnd();
}

export async function generateReportFile(
  report: EnergyReport,
  opts: { title: string; periodLabel: string; format: "xlsx" | "pdf"; fileBase: string },
): Promise<GeneratedReport> {
  const dir = reportOutDir();
  const filename = `${opts.fileBase}.${opts.format}`;
  const filePath = path.join(dir, filename);
  let buf: Buffer;
  if (opts.format === "xlsx") {
    buf = await buildXlsx(report, opts.title, opts.periodLabel);
  } else {
    const head = headerLines(report, opts.title, opts.periodLabel).map((r) => r[0] ?? "");
    const rows = tableRows(report);
    const lines = [
      ...head,
      tableLine(rows[0]),
      tableLine(rows[0].map((h) => "-".repeat(Math.max(3, h.length)))),
      ...rows.slice(1).map(tableLine),
    ];
    buf = buildPdf(lines);
  }
  fs.writeFileSync(filePath, buf);
  return { path: filePath, bytes: buf.length, filename };
}
