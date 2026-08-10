// Probe: the alarms_active_dedup_uniq unique index must reject a concurrent
// duplicate of an ongoing (active) alarm (v5 #7 evidence).
import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb } from "../api/queries/connection";

async function main() {
  const db = getDb();
  const act = await db.execute(sql`
    SELECT id, rule_id, meter_id, gateway_id, metric FROM alarms
    WHERE status = 'active' AND metric = 'socPercent'
  `);
  const rows = act[0] as unknown as Array<{ id: number; rule_id: number; meter_id: number; gateway_id: number; metric: string }>;
  console.log("active socPercent alarms:", rows.length);
  const a = rows[0];
  if (!a) {
    console.log("no active socPercent alarm to probe with — SKIP");
    process.exit(0);
  }
  try {
    await db.execute(sql`
      INSERT INTO alarms (rule_id, meter_id, gateway_id, metric, value, threshold, severity, message, status, triggered_at)
      VALUES (${a.rule_id}, ${a.meter_id}, ${a.gateway_id}, ${a.metric}, 1, 100, 'warning', 'dupe probe', 'active', NOW())
    `);
    console.log("FAIL: duplicate inserted — constraint not working");
    process.exit(1);
  } catch (e) {
    console.log("PASS: duplicate rejected —", (e as Error).message.slice(0, 100));
  }
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
