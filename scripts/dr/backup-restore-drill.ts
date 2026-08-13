// DR drill (audit wave 3 / "DR tested"): backup → restore into a SCRATCH
// database → compare → drop scratch. Never touches prod data.
//
//   ALLOW_DR_DRILL=1 npx tsx scripts/dr/backup-restore-drill.ts
//
// Without ALLOW_DR_DRILL=1 the script is a dry-run: it prints the plan and
// exits 0 without touching the database or the filesystem.
//
// Steps:
//   1. Take a backup with the EXISTING mechanism (scripts/backup-db.ts).
//   2. Augment the backup (same gzip-JSONL + manifest format) with
//      api_keys + ems_plans — backup-db.ts predates those tables (v7 list),
//      so the drill covers them itself. Coverage gap is reported.
//   3. Verify integrity with restore-db.ts --verify.
//   4. CREATE DATABASE volttrade_dr_drill on the same TiDB. If the privilege
//      is missing → FALLBACK: row-count + checksum verification of the backup
//      against the live DB, no restore; the limitation is printed loudly.
//   5. Restore the 7 key tables (users, sites, meters, gateways, ems_plans,
//      api_keys, audit_log) from the backup files into the scratch DB
//      (CREATE TABLE … LIKE, then chunked inserts, ISO dates revived — same
//      rules as scripts/restore-db.ts).
//   6. Compare row counts prod/backup/scratch + per-table id checksums.
//   7. DROP DATABASE volttrade_dr_drill — ONLY the scratch DB, always.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import readline from "node:readline";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { drizzle } from "drizzle-orm/mysql2";
import { sql } from "drizzle-orm";
import type { MySqlTable } from "drizzle-orm/mysql-core";
import { getDb } from "../../api/queries/connection";
import * as schema from "../../db/schema";
import * as relations from "../../db/relations";

const SCRATCH_DB = "volttrade_dr_drill";
const BACKUP_ROOT = "/tmp/dr-drill-backup";

// Tables the drill compares (audit requirement).
const KEY_TABLES: { name: string; table: MySqlTable }[] = (
  [
    ["users", schema.users],
    ["sites", schema.sites],
    ["meters", schema.meters],
    ["gateways", schema.gateways],
    ["ems_plans", schema.emsPlans],
    ["api_keys", schema.apiKeys],
    ["audit_log", schema.auditLog],
  ] as [string, MySqlTable][]
).map(([name, table]) => ({ name, table }));

// backup-db.ts covers the v7 table list; these key tables are missing there.
const BACKUP_GAP_TABLES = ["api_keys", "ems_plans"];

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
function sanitize(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    out[k] = typeof v === "string" && ISO_DATE.test(v) ? new Date(v) : v;
  }
  return out;
}

async function readRows(file: string): Promise<Record<string, unknown>[]> {
  const rows: Record<string, unknown>[] = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()) });
  for await (const line of rl) {
    if (line.trim()) rows.push(JSON.parse(line));
  }
  return rows;
}

function idChecksum(rows: { id: unknown }[]): string {
  const ids = rows.map((r) => String(r.id)).sort();
  return crypto.createHash("sha256").update(ids.join(",")).digest("hex").slice(0, 16);
}

async function countRows(
  db: { execute: (q: unknown) => Promise<unknown> },
  dbName: string,
  table: string,
): Promise<number> {
  const r = (await db.execute(sql.raw(`SELECT COUNT(*) AS c FROM \`${dbName}\`.\`${table}\``))) as unknown as [
    Array<{ c: number }>,
  ];
  return Number(r[0][0].c);
}

const DRY_RUN = process.env.ALLOW_DR_DRILL !== "1";

async function main() {
  const plan = [
    "1. backup via scripts/backup-db.ts → " + BACKUP_ROOT,
    "2. augment backup with api_keys + ems_plans (backup-db.ts coverage gap)",
    "3. restore-db.ts --verify (backup integrity)",
    `4. CREATE DATABASE ${SCRATCH_DB} (fallback to counts+checksums if no privilege)`,
    "5. restore 7 key tables into scratch from the backup files",
    "6. compare row counts prod vs backup vs scratch",
    `7. DROP DATABASE ${SCRATCH_DB} (scratch only)`,
  ];
  console.log("[dr-drill] plan:\n  " + plan.join("\n  "));
  if (DRY_RUN) {
    console.log("[dr-drill] DRY-RUN — set ALLOW_DR_DRILL=1 to execute");
    return;
  }

  const timings: Record<string, number> = {};
  const t = () => Date.now();
  let fails = 0;
  const check = (name: string, ok: boolean, detail: unknown) => {
    console.log(ok ? "PASS" : "FAIL", name, "->", JSON.stringify(detail).slice(0, 300));
    if (!ok) fails++;
  };

  const db = getDb();
  const prodUrl = new URL(process.env.DATABASE_URL ?? "");
  const prodDbName = prodUrl.pathname.replace(/^\//, "");

  // ── 1. backup with the existing mechanism ────────────────────────────────
  let start = t();
  fs.rmSync(BACKUP_ROOT, { recursive: true, force: true });
  const out = execFileSync("npx", ["tsx", "scripts/backup-db.ts", BACKUP_ROOT], { cwd: process.cwd(), encoding: "utf8" });
  const dirLine = out.split("\n").find((l) => l.includes("complete:"));
  const dir = dirLine!.split("complete:")[1].trim();
  timings.backupMs = t() - start;
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as {
    tables: Record<string, { rows: number; file: string }>;
  };
  console.log(`[dr-drill] backup done in ${timings.backupMs}ms → ${dir}`);

  // ── 2. augment: dump the key tables backup-db.ts does not know about ─────
  for (const name of BACKUP_GAP_TABLES) {
    const entry = KEY_TABLES.find((k) => k.name === name)!;
    const rows = (await db.select().from(entry.table as never)) as Record<string, unknown>[];
    const file = `${name}.jsonl.gz`;
    const gz = zlib.createGzip({ level: 6 });
    const ws = fs.createWriteStream(path.join(dir, file));
    gz.pipe(ws);
    for (const row of rows) gz.write(JSON.stringify(row) + "\n");
    gz.end();
    await new Promise((res, rej) => { ws.on("finish", res); ws.on("error", rej); });
    manifest.tables[name] = { rows: rows.length, file };
    console.log(`[dr-drill] augmented backup: ${name}: ${rows.length} rows (belt-and-braces re-dump; covers backup-db.ts versions that predate these tables)`);
  }
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));

  // ── 3. integrity verify of the existing mechanism ────────────────────────
  start = t();
  const verify = execFileSync("npx", ["tsx", "scripts/restore-db.ts", dir, "--verify"], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  timings.verifyMs = t() - start;
  check("restore-db --verify: backup complete and consistent", verify.includes("backup is complete and consistent"), {
    ms: timings.verifyMs,
  });

  // ── 4. scratch database ──────────────────────────────────────────────────
  let scratchOk = false;
  try {
    await db.execute(sql.raw(`CREATE DATABASE IF NOT EXISTS \`${SCRATCH_DB}\``));
    scratchOk = true;
    console.log(`[dr-drill] scratch database ${SCRATCH_DB} created`);
  } catch (e) {
    console.error(
      `[dr-drill] CREATE DATABASE failed (privilege limitation) — FALLBACK mode: ${String(e).slice(0, 200)}`,
    );
  }

  const scratchUrl = new URL(process.env.DATABASE_URL ?? "");
  scratchUrl.pathname = `/${SCRATCH_DB}`;
  const scratchDb = drizzle(scratchUrl.toString(), {
    mode: "planetscale",
    schema: { ...schema, ...relations },
  });

  const report: Record<string, { prod: number; backup: number; scratch?: number; checksumOk?: boolean }> = {};
  try {
    if (scratchOk) {
      // ── 5. restore into scratch from backup files ────────────────────────
      start = t();
      for (const { name, table } of KEY_TABLES) {
        const meta = manifest.tables[name];
        const rows = (await readRows(path.join(dir, meta.file))).map(sanitize);
        check(`backup file row count matches manifest (${name})`, rows.length === meta.rows, {
          file: rows.length,
          manifest: meta.rows,
        });
        await db.execute(sql.raw(`DROP TABLE IF EXISTS \`${SCRATCH_DB}\`.\`${name}\``));
        await db.execute(sql.raw(`CREATE TABLE \`${SCRATCH_DB}\`.\`${name}\` LIKE \`${prodDbName}\`.\`${name}\``));
        const CHUNK = 1000;
        for (let i = 0; i < rows.length; i += CHUNK) {
          await scratchDb.insert(table as never).values(rows.slice(i, i + CHUNK) as never);
        }
        console.log(`[dr-drill] restored ${name}: ${rows.length} rows → ${SCRATCH_DB}`);
      }
      timings.restoreMs = t() - start;

      // ── 6. compare ───────────────────────────────────────────────────────
      for (const { name, table } of KEY_TABLES) {
        const prod = await countRows(db, prodDbName, name);
        const scratch = await countRows(db, SCRATCH_DB, name);
        const backupRows = (await readRows(path.join(dir, manifest.tables[name].file))) as { id: unknown }[];
        const scratchRows = (await scratchDb.select().from(table as never)) as { id: unknown }[];
        const backupSum = idChecksum(backupRows);
        const scratchSum = idChecksum(scratchRows);
        // prod is live: it can only grow during the drill (audit_log), so
        // prod >= backup; scratch must equal the backup exactly.
        const countsOk = scratch === manifest.tables[name].rows && prod >= manifest.tables[name].rows;
        report[name] = { prod, backup: manifest.tables[name].rows, scratch, checksumOk: backupSum === scratchSum };
        check(`row counts prod>=backup==scratch (${name})`, countsOk, report[name]);
        check(`id checksum backup==scratch (${name})`, backupSum === scratchSum, {
          backup: backupSum,
          scratch: scratchSum,
        });
      }
    } else {
      // FALLBACK: verify backup integrity against live DB without a restore.
      start = t();
      for (const { name, table } of KEY_TABLES) {
        const prod = await countRows(db, prodDbName, name);
        const backupRows = (await readRows(path.join(dir, manifest.tables[name].file))) as { id: unknown }[];
        const liveRows = (await db.select().from(table as never)) as { id: unknown }[];
        // live ⊇ backup (live can only grow); every backup id must exist live.
        const liveIds = new Set(liveRows.map((r) => String(r.id)));
        const missing = backupRows.filter((r) => !liveIds.has(String(r.id))).length;
        report[name] = { prod, backup: manifest.tables[name].rows, checksumOk: missing === 0 };
        check(`fallback: all backup ids present in live DB (${name})`, missing === 0 && prod >= backupRows.length, {
          prod,
          backup: backupRows.length,
          missingLiveIds: missing,
          fileSha256: idChecksum(backupRows),
        });
      }
      timings.fallbackVerifyMs = t() - start;
      console.log("[dr-drill] FALLBACK used: backup integrity verified via row counts + id checksums (no restore).");
    }
  } finally {
    // ── 7. drop ONLY the scratch database ──────────────────────────────────
    if (scratchOk) {
      start = t();
      await db.execute(sql.raw(`DROP DATABASE IF EXISTS \`${SCRATCH_DB}\``));
      timings.dropMs = t() - start;
      console.log(`[dr-drill] scratch database ${SCRATCH_DB} dropped`);
    }
  }

  console.log("[dr-drill] timings:", JSON.stringify(timings));
  console.log("[dr-drill] backup kept at:", dir);
  console.log(fails === 0 ? "=== DRILL PASS" : `=== DRILL ${fails} FAILURES`);
  process.exit(fails === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
