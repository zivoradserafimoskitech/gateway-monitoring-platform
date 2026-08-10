// v7/C8 probe: site-scope energy report buckets days at the site's LOCAL
// midnight. Data straddling UTC midnight (22:30/23:30 UTC = 00:30/01:30
// Europe/Skopje next day) must land in ONE local day, not two UTC days.
import "dotenv/config";
import { getDb } from "../api/queries/connection";
import { gateways, meters, sites, telemetry } from "../db/schema";
import { eq } from "drizzle-orm";
import { localDayRanges } from "../api/lib/tz";

async function main() {
  const db = getDb();
  let fails = 0;
  const probe = (n: string, ok: boolean, d: unknown) => {
    console.log(ok ? "PASS" : "FAIL", n, "->", JSON.stringify(d).slice(0, 200));
    if (!ok) fails++;
  };

  // unit: tz math — Skopje local midnight for 2026-08-03 = 2026-08-02T22:00Z (CEST, UTC+2)
  const ranges = localDayRanges("Europe/Skopje", new Date("2026-08-02T00:00:00Z"), new Date("2026-08-05T00:00:00Z"));
  const d3 = ranges.find((r) => r.label === "2026-08-03");
  probe(
    "tz math: local day 2026-08-03 starts 2026-08-02T22:00Z",
    d3?.startUtc.toISOString() === "2026-08-02T22:00:00.000Z" && d3?.endUtc.toISOString() === "2026-08-03T22:00:00.000Z",
    d3,
  );

  // fixtures
  const s = await db.insert(sites).values({ name: "tz probe site", timezone: "Europe/Skopje" }).$returningId();
  const g = await db
    .insert(gateways)
    .values({ uid: "gw-tz-probe", name: "tz probe", model: "TCP", transport: "tcp", topicPrefix: "-" })
    .$returningId();
  const m = await db
    .insert(meters)
    .values({ gatewayId: g[0].id, siteId: s[0].id, name: "tz meter", model: "PEM3000", modbusAddress: 1 })
    .$returningId();
  const meterId = m[0].id;

  // counter grows 10 kWh per reading: 22:30 & 23:30 UTC Aug 3 (= Aug 4 local),
  // 12:00 & 13:00 UTC Aug 4 (= Aug 4 local afternoon)
  const rows = [
    { ts: new Date("2026-08-03T22:30:00Z"), e: 100 },
    { ts: new Date("2026-08-03T23:30:00Z"), e: 110 },
    { ts: new Date("2026-08-04T12:00:00Z"), e: 120 },
    { ts: new Date("2026-08-04T13:00:00Z"), e: 130 },
  ];
  await db.insert(telemetry).values(rows.map((r) => ({ meterId, ts: r.ts, energyImportKwh: r.e })));

  const { getTelemetryStore } = await import("../api/telemetry");
  const store = getTelemetryStore();
  const from = new Date("2026-08-02T00:00:00Z");
  const to = new Date("2026-08-05T23:59:59Z");

  const utc = await store.dailyReport(meterId, from, to);
  const local = await store.dailyReport(meterId, from, to, { dayBuckets: localDayRanges("Europe/Skopje", from, to) });
  console.log("UTC:", JSON.stringify(utc.map((d) => [d.day, d.importKwh])));
  console.log("LOCAL:", JSON.stringify(local.map((d) => [d.day, d.importKwh])));

  // mysql2/DB tz shift can move bucket membership at the edges (as seen in C7);
  // the load-bearing assertions are about the LOCAL grouping behavior:
  const localAug4 = local.find((d) => d.day === "2026-08-04");
  const utcDays = new Set(utc.filter((d) => (d.importKwh ?? 0) > 0).map((d) => d.day));
  const localDays = new Set(local.filter((d) => (d.importKwh ?? 0) > 0).map((d) => d.day));
  probe(
    "UTC buckets the straddling hours into 2 days",
    utcDays.size === 2,
    [...utcDays],
  );
  probe(
    "LOCAL buckets ALL four readings into 2026-08-04 (Skopje)",
    localDays.size >= 1 && localAug4 !== undefined && (localAug4.importKwh ?? 0) >= 30,
    [...localDays, localAug4?.importKwh],
  );

  await db.delete(telemetry).where(eq(telemetry.meterId, meterId));
  await db.delete(meters).where(eq(meters.id, meterId));
  await db.delete(gateways).where(eq(gateways.id, g[0].id));
  await db.delete(sites).where(eq(sites.id, s[0].id));
  console.log(fails === 0 ? "=== ALL PASS" : `=== ${fails} FAILURES`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
