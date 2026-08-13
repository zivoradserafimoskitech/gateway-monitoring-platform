// v7/C10: restore a backup produced by scripts/backup-db.ts.
//
//   npx tsx scripts/restore-db.ts <backup-dir> --verify   # counts only, no writes
//   ALLOW_UNSAFE_PROD=1 npx tsx scripts/restore-db.ts <backup-dir> --yes
//
// DESTRUCTIVE: every table is emptied and replaced by the backup contents.
// Requires BOTH the remote-DB opt-in (session rule) and the explicit --yes
// flag. Generated columns (e.g. alarms.active_dedup_key) are stripped;
// ISO date strings are revived to Date objects for timestamp columns.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import readline from "node:readline";
import { getDb } from "../api/queries/connection";
import * as schema from "../db/schema";
import type { MySqlTable } from "drizzle-orm/mysql-core";

const TABLES: { name: string; table: MySqlTable }[] = (
  [
    ["sites", schema.sites],
    ["gateways", schema.gateways],
    ["meters", schema.meters],
    ["telemetry", schema.telemetry],
    ["telemetry_hourly", schema.telemetryHourly],
    ["alarm_rules", schema.alarmRules],
    ["alarms", schema.alarms],
    ["device_profiles", schema.deviceProfiles],
    ["commands", schema.commands],
    ["users", schema.users],
    ["sessions", schema.sessions],
    ["audit_log", schema.auditLog],
    ["notification_channels", schema.notificationChannels],
    ["alarm_notifications", schema.alarmNotifications],
    ["maintenance_windows", schema.maintenanceWindows],
    // v8/v9 tables — mirror of scripts/backup-db.ts (audit wave-3 DR drill
    // found them missing from the v7 list).
    ["orgs", schema.orgs],
    ["api_keys", schema.apiKeys],
    ["ems_schedules", schema.emsSchedules],
    ["ems_peak_shaving", schema.emsPeakShaving],
    ["ems_plans", schema.emsPlans],
    ["report_schedules", schema.reportSchedules],
    ["ota_jobs", schema.otaJobs],
  ] as [string, MySqlTable][]
).map(([name, table]) => ({ name, table }));

const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
// Generated columns must never be inserted into.
const GENERATED: Record<string, string[]> = { alarms: ["activeDedupKey"] };

function sanitize(table: string, row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const skip = new Set(GENERATED[table] ?? []);
  for (const [k, v] of Object.entries(row)) {
    if (skip.has(k)) continue;
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

async function main() {
  const dir = process.argv[2];
  const verifyOnly = process.argv.includes("--verify");
  const yes = process.argv.includes("--yes");
  if (!dir || !fs.existsSync(path.join(dir, "manifest.json"))) {
    console.error("usage: restore-db.ts <backup-dir> [--verify] [--yes]");
    process.exit(1);
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf8")) as {
    tables: Record<string, { rows: number; file: string }>;
  };

  if (!verifyOnly) {
    const url = process.env.DATABASE_URL ?? "";
    const local = /localhost|127\.0\.0\.1/.test(url);
    if (!local && process.env.ALLOW_UNSAFE_PROD !== "1") {
      console.error("restore-db refuses to run against a remote DB without ALLOW_UNSAFE_PROD=1");
      process.exit(1);
    }
    if (!yes) {
      console.error("restore-db is DESTRUCTIVE (empties + replaces every table) — pass --yes to confirm");
      process.exit(1);
    }
  }

  const db = getDb();
  for (const { name, table } of TABLES) {
    const meta = manifest.tables[name];
    if (!meta) {
      console.error(`[restore] manifest has no entry for ${name} — aborting (incomplete backup)`);
      process.exit(1);
    }
    const rows = (await readRows(path.join(dir, meta.file))).map((r) => sanitize(name, r));
    if (rows.length !== meta.rows) {
      console.error(`[restore] ${name}: file has ${rows.length} rows but manifest says ${meta.rows} — aborting`);
      process.exit(1);
    }
    if (verifyOnly) {
      console.log(`[verify] ${name}: ${rows.length} rows ok`);
      continue;
    }
    await db.delete(table as never);
    const CHUNK = 1000;
    for (let i = 0; i < rows.length; i += CHUNK) {
      await db.insert(table as never).values(rows.slice(i, i + CHUNK) as never);
    }
    console.log(`[restore] ${name}: ${rows.length} rows restored`);
  }
  console.log(verifyOnly ? "[verify] backup is complete and consistent" : "[restore] complete");
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
