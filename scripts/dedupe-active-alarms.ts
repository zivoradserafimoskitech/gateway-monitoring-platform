// One-off: resolve duplicate active/acknowledged alarms (same rule+meter+
// gateway+metric), keeping the oldest row — prerequisite for the
// alarms_active_dedup_uniq unique index (v5 #7).
// Run: npx tsx scripts/dedupe-active-alarms.ts
import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb } from "../api/queries/connection";

async function main() {
  const db = getDb();
  const dupes = await db.execute(sql`
    SELECT coalesce(rule_id,0) r, coalesce(meter_id,0) m, coalesce(gateway_id,0) g,
           metric, count(*) n, min(id) keepId
    FROM alarms
    WHERE status IN ('active','acknowledged')
    GROUP BY 1,2,3,4
    HAVING n > 1
  `);
  const groups = dupes[0] as unknown as Array<{ r: number; m: number; g: number; metric: string; n: number; keepId: number }>;
  console.log("dupe groups:", groups.length);
  for (const d of groups) {
    await db.execute(sql`
      UPDATE alarms SET status='resolved', resolved_at=NOW()
      WHERE status IN ('active','acknowledged')
        AND coalesce(rule_id,0)=${d.r} AND coalesce(meter_id,0)=${d.m}
        AND coalesce(gateway_id,0)=${d.g} AND metric=${d.metric}
        AND id <> ${d.keepId}
    `);
    console.log(`resolved ${d.n - 1} dupe(s) for metric=${d.metric} keep id=${d.keepId}`);
  }
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
