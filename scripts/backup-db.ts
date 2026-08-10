// v7/C10: full-database backup → timestamped directory of gzip'd JSONL files
// (one per table) plus a manifest.json with row counts and metadata.
//
//   npx tsx scripts/backup-db.ts [output-root]      # default: backups/
//
// Restore with scripts/restore-db.ts. See docs/runbook-backup-dr.md.
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { getDb } from "../api/queries/connection";
import * as schema from "../db/schema";
import { getTableColumns } from "drizzle-orm";
import type { MySqlTable } from "drizzle-orm/mysql-core";

const TABLES: { name: string; table: MySqlTable }[] = [
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
].map(([name, table]) => ({ name: name as string, table: table as MySqlTable }));

async function main() {
  const root = process.argv[2] || "backups";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = path.join(root, stamp);
  fs.mkdirSync(dir, { recursive: true });

  const db = getDb();
  const manifest: Record<string, unknown> = {
    createdAt: new Date().toISOString(),
    databaseUrlHost: (process.env.DATABASE_URL ?? "").replace(/\/\/.*@/, "//***@").replace(/:.+@/, ":***@"),
    tables: {} as Record<string, { rows: number; file: string; columns: number }>,
  };

  for (const { name, table } of TABLES) {
    const rows = await db.select().from(table as never);
    const file = `${name}.jsonl.gz`;
    const gz = zlib.createGzip({ level: 6 });
    const out = fs.createWriteStream(path.join(dir, file));
    gz.pipe(out);
    for (const row of rows as Record<string, unknown>[]) {
      gz.write(JSON.stringify(row) + "\n");
    }
    gz.end();
    await new Promise((res, rej) => { out.on("finish", res); out.on("error", rej); });
    const cols = Object.keys(getTableColumns(table)).length;
    (manifest.tables as Record<string, { rows: number; file: string; columns: number }>)[name] = {
      rows: rows.length,
      file,
      columns: cols,
    };
    console.log(`[backup] ${name}: ${rows.length} rows → ${file}`);
  }
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest, null, 2));
  console.log(`[backup] complete: ${dir}`);
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
