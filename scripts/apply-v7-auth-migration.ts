// v7/C1: apply 0003_v7_auth.sql idempotently.
import { getDb } from "../api/queries/connection";
import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";

async function main() {
  const db = getDb();
  const stmts = readFileSync("db/migrations/0003_v7_auth.sql", "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean);
  for (const s of stmts) {
    try {
      await db.execute(sql.raw(s));
      console.log("ok:", s.slice(0, 60).replace(/\n/g, " "));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (/already exists|Duplicate/i.test(msg)) console.log("skip (exists):", s.slice(0, 60).replace(/\n/g, " "));
      else throw e;
    }
  }
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
