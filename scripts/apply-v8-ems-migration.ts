// v8/D1: apply db/migrations/0009_v8-ems.sql (ems_schedules, ems_peak_shaving).
// Additive CREATE TABLE/INDEX only — safe against the remote production TiDB.
//   npx tsx scripts/apply-v8-ems-migration.ts [path-to-sql]
import "dotenv/config";
import { getDb } from "../api/queries/connection";
import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
async function main() {
  const db = getDb();
  const file = process.argv[2] ?? "db/migrations/0009_v8-ems.sql";
  const stmts = readFileSync(file, "utf8").split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
  for (const s of stmts) {
    try { await db.execute(sql.raw(s)); console.log("ok:", s.slice(0, 50).replace(/\n/g, " ")); }
    catch (e) { const m = e instanceof Error ? e.message : String(e);
      if (/already exists|Duplicate/i.test(m)) console.log("skip:", s.slice(0, 50).replace(/\n/g, " ")); else throw e; }
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
