// v7/C7 probe: counter reset inside a day must not explode the energy total.
// Day A: counter 100→150 (normal, 50 kWh). Day B: 150→180, reset to 0, →30
// (real usage = 30 post-reset + 30 pre-reset = 60, NOT max−min = 180).
import "dotenv/config";
import { getDb } from "../api/queries/connection";
import { gateways, meters, telemetry } from "../db/schema";
import { eq } from "drizzle-orm";
import { getTelemetryStore } from "../api/telemetry";

const DAY = 86_400_000;

async function main() {
  const db = getDb();
  const gw = await db
    .insert(gateways)
    .values({ uid: "gw-reset-probe", name: "reset probe", model: "TCP", transport: "tcp", topicPrefix: "-" })
    .$returningId();
  const mid = await db
    .insert(meters)
    .values({ gatewayId: gw[0].id, name: "reset probe meter", model: "PEM3000", modbusAddress: 1 })
    .$returningId();
  const meterId = mid[0].id;

  const dayA = new Date("2026-08-01T00:00:00Z").getTime();
  const rows: { ts: Date; e: number }[] = [];
  for (let h = 0; h < 24; h++) rows.push({ ts: new Date(dayA + h * 3_600_000), e: 100 + h * (50 / 23) }); // A: 100→150
  for (let h = 24; h < 36; h++) rows.push({ ts: new Date(dayA + h * 3_600_000), e: 150 + (h - 24) * 2.5 }); // B: 150→177.5
  for (let h = 36; h < 48; h++) rows.push({ ts: new Date(dayA + h * 3_600_000), e: (h - 36) * 2.5 }); // B post-reset: 0→27.5
  await db.insert(telemetry).values(
    rows.map((r) => ({ meterId, ts: r.ts, energyImportKwh: r.e, activePowerKw: 5 })),
  );

  // Wide window — mysql2/DB timezone interplay can shift edge rows; the
  // invariants below hold regardless of where bucket boundaries land.
  const report = await getTelemetryStore().dailyReport(
    meterId,
    new Date(dayA - 12 * 3_600_000),
    new Date(dayA + 2 * DAY + 12 * 3_600_000),
  );
  console.log(JSON.stringify(report, null, 1));
  const total = report.reduce((s, r) => s + (r.importKwh ?? 0), 0);
  const resetDays = report.filter((r) => r.counterReset).length;
  const maxDay = Math.max(...report.map((r) => r.importKwh ?? 0));
  // Truth: deltas 100→150 (50) + 150→177.5 (27.5) + reset + 0→27.5 (27.5) = 105
  // minus the very first row's null-lag delta (~2.2) → ≈102.8. Old max−min
  // logic would report 150 + 177.5 = 327.5 across the two days.
  const okTotal = total > 95 && total < 110;
  const okReset = resetDays === 1;
  const okNoExplosion = maxDay < 100;

  await db.delete(telemetry).where(eq(telemetry.meterId, meterId));
  await db.delete(meters).where(eq(meters.id, meterId));
  await db.delete(gateways).where(eq(gateways.id, gw[0].id));

  console.log(okTotal ? "PASS" : "FAIL", "total ≈105 (not 327.5 max−min)", total);
  console.log(okReset ? "PASS" : "FAIL", "exactly one counterReset day", resetDays);
  console.log(okNoExplosion ? "PASS" : "FAIL", "no exploded day (max<100)", maxDay);
  const ok = okTotal && okReset && okNoExplosion;
  console.log(ok ? "=== ALL PASS" : "=== FAILURES");
  process.exit(ok ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
