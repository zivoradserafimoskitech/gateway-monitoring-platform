// v8/D3 probe: scheduled reports.
//  1. runNow on a daily XLSX schedule (site 1) → file exists in data/reports/,
//     PK zip signature, parses as a workbook, sheet xml has the table header.
//  2. runNow on a PDF schedule → %PDF- header + %%EOF trailer, non-trivial size.
//  3. Email transport invoked — runNow reports the log transport AND the
//     server log carries the [mailer] LOG TRANSPORT line with the recipient.
//  4. lastRunAt updated after runNow.
//  5. viewer → FORBIDDEN on reports.schedules.create.
//  6. cleanup: schedules + generated files removed.
// Requires dev server with EMAIL_TRANSPORT=log. Run: npx tsx scripts/probe-v8-reports.ts
import "dotenv/config";
import fs from "node:fs";
import { eq } from "drizzle-orm";
import * as XLSX from "xlsx";
import { getDb } from "../api/queries/connection";
import { reportSchedules, users } from "../db/schema";

const BASE = "http://localhost:3000";
const jars: Record<string, string> = {};

let fails = 0;
function probe(name: string, ok: boolean, detail: unknown): void {
  console.log(ok ? "PASS" : "FAIL", name, "->", JSON.stringify(detail).slice(0, 240));
  if (!ok) fails++;
}

async function trpc(proc: string, payload: unknown, who?: string, method: "POST" | "GET" = "POST"): Promise<unknown> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (who && jars[who]) headers.cookie = jars[who];
  let url = `${BASE}/api/trpc/${proc}?batch=1`;
  const init: RequestInit = { method, headers };
  if (method === "POST") init.body = JSON.stringify({ "0": { json: payload } });
  else url += `&input=${encodeURIComponent(JSON.stringify({ "0": { json: payload ?? null, meta: payload == null ? { values: ["undefined"] } : undefined } }))}`;
  const res = await fetch(url, init);
  const setCookie = res.headers.get("set-cookie");
  if (who && setCookie) jars[who] = setCookie.split(";")[0];
  const body = await res.json();
  const b = Array.isArray(body) ? body[0] : body;
  if (b.error) {
    const err = new Error(b.error.json?.message ?? JSON.stringify(b.error)) as Error & { httpStatus?: number };
    err.httpStatus = res.status;
    throw err;
  }
  return b.result.data.json;
}

interface RunRes { scheduleId: number; path: string; filename: string; bytes: number; transport: string; period: string; recipients: number }

async function main() {
  const db = getDb();
  await trpc("auth.login", { email: "admin@enertrek.local", password: "admin1234" }, "admin");
  const viewerEmail = "c12-viewer@enertrek.local";
  const viewers = await db.select().from(users).where(eq(users.email, viewerEmail));
  if (viewers.length) await trpc("auth.login", { email: viewerEmail, password: "viewer1234" }, "viewer");

  let idX = 0;
  let idP = 0;
  const files: string[] = [];
  try {
    // create both schedules
    const cx = (await trpc("reports.schedules.create", { siteId: 1, name: "probe-xlsx", frequency: "daily", format: "xlsx", recipients: ["probe@example.com"], hourLocal: 8 }, "admin")) as { id: number };
    const cp = (await trpc("reports.schedules.create", { siteId: 1, name: "probe-pdf", frequency: "daily", format: "pdf", recipients: ["probe@example.com"], hourLocal: 8 }, "admin")) as { id: number };
    idX = cx.id;
    idP = cp.id;
    probe("schedules created (xlsx + pdf, site 1)", idX > 0 && idP > 0, { idX, idP });

    // 1. xlsx runNow
    const rx = (await trpc("reports.schedules.runNow", { id: idX }, "admin")) as RunRes;
    files.push(rx.path);
    const xok = fs.existsSync(rx.path);
    const xbuf = xok ? fs.readFileSync(rx.path) : Buffer.alloc(0);
    let sheetOk = false;
    let rowsN = 0;
    try {
      const wb = XLSX.read(xbuf, { type: "buffer" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(ws, { header: 1 }) as unknown[][];
      rowsN = rows.length;
      const flat = JSON.stringify(rows);
      sheetOk = wb.SheetNames[0] === "Energy" && flat.includes("Import kWh") && flat.includes("TOTAL");
    } catch {
      sheetOk = false;
    }
    probe(
      "runNow xlsx → file in data/reports/, PK signature, parses, sheet has table",
      xok && rx.bytes > 2000 && xbuf.slice(0, 2).toString("latin1") === "PK" && sheetOk && rx.path.includes("reports/"),
      { bytes: rx.bytes, rows: rowsN, sheetOk, path: rx.path.split("/").slice(-2).join("/") },
    );

    // 2. pdf runNow
    const rp = (await trpc("reports.schedules.runNow", { id: idP }, "admin")) as RunRes;
    files.push(rp.path);
    const pok = fs.existsSync(rp.path);
    const pbuf = pok ? fs.readFileSync(rp.path) : Buffer.alloc(0);
    probe(
      "runNow pdf → %PDF- header + %%EOF trailer, non-trivial size",
      pok && rp.bytes > 800 && pbuf.slice(0, 5).toString("latin1") === "%PDF-" && pbuf.slice(-8).toString("latin1").includes("%%EOF"),
      { bytes: rp.bytes, head: pbuf.slice(0, 8).toString("latin1"), tail: pbuf.slice(-6).toString("latin1") },
    );

    // 3. mail transport
    const logText = fs.existsSync("/tmp/dev-server.log") ? fs.readFileSync("/tmp/dev-server.log", "utf8") : "";
    const mailLines = logText.split("\n").filter((l) => l.includes("[mailer] LOG TRANSPORT") && l.includes("probe@example.com"));
    probe(
      "email transport invoked (log transport + server log line)",
      rx.transport === "log" && rp.transport === "log" && mailLines.length >= 2,
      { transport: [rx.transport, rp.transport], logLines: mailLines.length, sample: mailLines[0]?.slice(0, 120) },
    );

    // 4. lastRunAt updated
    const list = (await trpc("reports.schedules.list", null, "admin", "GET")) as Array<{ id: number; lastRunAt: string | null }>;
    const lx = list.find((s) => s.id === idX);
    const lp = list.find((s) => s.id === idP);
    probe("lastRunAt updated for both schedules", !!lx?.lastRunAt && !!lp?.lastRunAt, { xlsx: lx?.lastRunAt, pdf: lp?.lastRunAt });

    // 5. viewer forbidden
    if (jars.viewer) {
      let denied = "";
      try {
        await trpc("reports.schedules.create", { siteId: 1, name: "x", frequency: "daily", format: "pdf", recipients: ["a@b.co"], hourLocal: 1 }, "viewer");
      } catch (e) {
        denied = (e as Error).message;
      }
      const vList = await trpc("reports.schedules.list", null, "viewer", "GET");
      probe("viewer: list allowed, create FORBIDDEN", Array.isArray(vList) && /Requires role/.test(denied), { denied });
    }
  } finally {
    // 6. cleanup
    if (idX) await db.delete(reportSchedules).where(eq(reportSchedules.id, idX)).catch(() => undefined);
    if (idP) await db.delete(reportSchedules).where(eq(reportSchedules.id, idP)).catch(() => undefined);
    for (const f of files) {
      try { fs.unlinkSync(f); } catch { /* already gone */ }
    }
  }

  console.log(fails === 0 ? "=== ALL PASS" : `=== ${fails} FAILURES`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
