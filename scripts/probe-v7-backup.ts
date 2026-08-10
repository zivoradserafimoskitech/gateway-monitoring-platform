// v7/C10 probe: backup & restore.
//  1. backup-db.ts produces a complete manifest (counts match live DB).
//  2. restore-db --verify passes (files consistent with manifest).
//  3. CANARY: a site created before the backup is deleted (simulated loss),
//     full restore brings it back; telemetry count matches the manifest.
//  4. restore-db without --yes / ALLOW_UNSAFE_PROD=1 refuses to write.
import "dotenv/config";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { getDb } from "../api/queries/connection";
import { sites, telemetry } from "../db/schema";
import { eq, sql as dsql } from "drizzle-orm";

const ROOT = "/tmp/backup-c10";

async function main() {
  const db = getDb();
  let fails = 0;
  const probe = (n: string, ok: boolean, d: unknown) => {
    console.log(ok ? "PASS" : "FAIL", n, "->", JSON.stringify(d).slice(0, 220));
    if (!ok) fails++;
  };
  fs.rmSync(ROOT, { recursive: true, force: true });

  // canary
  const c = await db.insert(sites).values({ name: "backup-canary-site" }).$returningId();
  const canaryId = c[0].id;

  // 1. backup
  const out = execFileSync("npx", ["tsx", "scripts/backup-db.ts", ROOT], { cwd: process.cwd(), encoding: "utf8" });
  const dirLine = out.split("\n").find((l) => l.includes("complete:"));
  const dir = dirLine!.split("complete:")[1].trim();
  const manifest = JSON.parse(fs.readFileSync(`${dir}/manifest.json`, "utf8"));
  const [telCount] = await db.select({ n: dsql<number>`count(*)` }).from(telemetry);
  const tables = Object.keys(manifest.tables);
  probe(
    "backup manifest covers all 15 tables; telemetry count in range",
    tables.length === 15 && manifest.tables.telemetry.rows <= Number(telCount.n) && manifest.tables.sites.rows >= 1,
    { tables: tables.length, backupTel: manifest.tables.telemetry.rows, liveTel: Number(telCount.n) },
  );

  // 2. verify mode
  const verify = execFileSync("npx", ["tsx", "scripts/restore-db.ts", dir, "--verify"], { cwd: process.cwd(), encoding: "utf8" });
  probe("restore --verify passes", verify.includes("backup is complete and consistent"), verify.split("\n").slice(-2));

  // 4. guards (run before the real restore): remote DB without opt-in must refuse
  let refused = "";
  try {
    execFileSync("npx", ["tsx", "scripts/restore-db.ts", dir, "--yes"], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, ALLOW_UNSAFE_PROD: "" } });
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; message?: string };
    refused = (err.stderr || "") + (err.stdout || "") + (err.message || "");
  }
  probe("restore without ALLOW_UNSAFE_PROD=1 refuses (remote DB guard)", refused.includes("refuses"), refused.trim().slice(0, 120));

  // 3. simulated loss + restore
  await db.delete(sites).where(eq(sites.id, canaryId));
  const gone = await db.select().from(sites).where(eq(sites.id, canaryId));
  execFileSync("npx", ["tsx", "scripts/restore-db.ts", dir, "--yes"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ALLOW_UNSAFE_PROD: "1" },
  });
  const back = await db.select().from(sites).where(eq(sites.id, canaryId));
  const [telAfter] = await db.select({ n: dsql<number>`count(*)` }).from(telemetry);
  // Live ingestion keeps writing during restore, so the post-restore count is
  // manifest + a small delta — never below the manifest (that would mean data
  // lost by the restore itself).
  probe(
    "canary site recovered by restore; telemetry count == manifest (+live delta)",
    gone.length === 0 &&
      back.length === 1 &&
      back[0].name === "backup-canary-site" &&
      Number(telAfter.n) >= manifest.tables.telemetry.rows &&
      Number(telAfter.n) <= manifest.tables.telemetry.rows + 200,
    { canary: back.length, telAfter: Number(telAfter.n), manifest: manifest.tables.telemetry.rows },
  );

  await db.delete(sites).where(eq(sites.id, canaryId));
  fs.rmSync(ROOT, { recursive: true, force: true });
  console.log(fails === 0 ? "=== ALL PASS" : `=== ${fails} FAILURES`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
