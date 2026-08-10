// v7/C6 probe: WAL-backed ingestion queue.
//  1. CRASH: child process pushes 3 rows and exits before the flush timer —
//     rows must survive as a WAL segment, NOT in the DB yet.
//  2. REPLAY: a new writer (next "boot") replays the segment → rows in DB,
//     segment file deleted.
//  3. FAILURE RETENTION: with a store that always fails, the batch is given
//     up after RETRY_MAX in-process — but the WAL segment SURVIVES and a later
//     replay delivers the rows (pre-C6 they were lost forever).
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { getDb } from "../api/queries/connection";
import { gateways, meters, telemetry } from "../db/schema";
import { eq, sql as dsql } from "drizzle-orm";
import { getTelemetryStore, BatchWriter } from "../api/telemetry";
import type { TelemetryStore } from "../api/telemetry/types";

const WAL = "/tmp/wal-probe";

async function main() {
  const db = getDb();
  let fails = 0;
  const probe = (n: string, ok: boolean, d: unknown) => {
    console.log(ok ? "PASS" : "FAIL", n, "->", JSON.stringify(d).slice(0, 200));
    if (!ok) fails++;
  };
  fs.rmSync(WAL, { recursive: true, force: true });

  const g = await db.insert(gateways).values({ uid: "gw-wal-probe", name: "wal probe", model: "TCP", transport: "tcp", topicPrefix: "-" }).$returningId();
  const m = await db.insert(meters).values({ gatewayId: g[0].id, name: "wal meter", model: "PEM3000", modbusAddress: 1 }).$returningId();
  const meterId = m[0].id;
  const countRows = async () => {
    const r = await db.select({ n: dsql<number>`count(*)` }).from(telemetry).where(eq(telemetry.meterId, meterId));
    return Number(r[0].n);
  };

  // 1. crash child
  execFileSync("npx", ["tsx", "scripts/wal-crash-child.ts", String(meterId), WAL], { cwd: process.cwd(), stdio: "pipe" });
  const pending = path.join(WAL, "pending.jsonl");
  const pendingLines = fs.existsSync(pending) ? fs.readFileSync(pending, "utf8").split("\n").filter(Boolean).length : 0;
  probe("crash: 3 rows in WAL pending segment, 0 in DB", pendingLines === 3 && (await countRows()) === 0, { pendingLines, db: await countRows() });

  // 2. next boot: constructor rotates pending, replayWal delivers
  const writer2 = new BatchWriter(getTelemetryStore(), { walDir: WAL });
  const replayed = await writer2.replayWal();
  probe("replay after crash: 3 rows reach DB, segment deleted", replayed.rows === 3 && (await countRows()) === 3 && fs.readdirSync(WAL).filter((f) => f.endsWith(".jsonl")).length === 0, { replayed, db: await countRows(), files: fs.readdirSync(WAL) });

  // 3. failing store: batch given up in-process, WAL survives, replay recovers
  const failStore: TelemetryStore = {
    writeBatch: async () => { throw new Error("db down (simulated)"); },
    latest: async () => null, latestAll: async () => new Map(),
    history: async () => [], powerTrend: async () => [], firstEnergySince: async () => null,
    firstEnergyAll: async () => new Map(), dailyReport: async () => [], close: async () => {},
  };
  const writer3 = new BatchWriter(failStore, { walDir: WAL });
  writer3.push({ meterId, ts: new Date("2026-08-10T11:00:00Z"), values: { energyImportKwh: 600 } });
  writer3.push({ meterId, ts: new Date("2026-08-10T11:01:00Z"), values: { energyImportKwh: 601 } });
  for (let i = 0; i < 8; i++) await writer3.flush(true); // exhaust RETRY_MAX=5
  const segAfterGiveUp = fs.readdirSync(WAL).filter((f) => /^f-.*\.jsonl$/.test(f));
  probe("failing store: batch gave up in-process but WAL segment survives", writer3.stats.failed === 2 && segAfterGiveUp.length === 1 && (await countRows()) === 3, { failed: writer3.stats.failed, segAfterGiveUp, db: await countRows() });

  const writer4 = new BatchWriter(getTelemetryStore(), { walDir: WAL });
  const replayed2 = await writer4.replayWal();
  probe("replay recovers the given-up batch (2 more rows in DB)", replayed2.rows === 2 && (await countRows()) === 5, { replayed: replayed2, db: await countRows() });

  await db.delete(telemetry).where(eq(telemetry.meterId, meterId));
  await db.delete(meters).where(eq(meters.id, meterId));
  await db.delete(gateways).where(eq(gateways.id, g[0].id));
  fs.rmSync(WAL, { recursive: true, force: true });
  console.log(fails === 0 ? "=== ALL PASS" : `=== ${fails} FAILURES`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
