// CSV cell encoding shared by exports — extracted from Reports.tsx so unit
// tests can pin the behavior (v5 #23).
//
// RFC-4180 quoting + spreadsheet formula-injection guard (v4 F-08): device
// names are user/MQTT-controlled, so cells starting with = + - @ would
// otherwise execute as formulas when the CSV is opened in Excel.
export function csvCell(v: unknown): string {
  let s = String(v ?? "");
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
