// One-off: apply the v5 #7 dedup migration to the live database —
// generated column + unique index on alarms. Idempotent-ish: refuses cleanly
// if the column already exists. Run: npx tsx scripts/apply-dedup-migration.ts
import "dotenv/config";
import { sql } from "drizzle-orm";
import { getDb } from "../api/queries/connection";

async function main() {
  const db = getDb();
  const cols = await db.execute(sql`
    SELECT COLUMN_NAME FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'alarms' AND COLUMN_NAME = 'active_dedup_key'
  `);
  if ((cols[0] as unknown as unknown[]).length > 0) {
    console.log("active_dedup_key already present — nothing to do");
    process.exit(0);
  }
  await db.execute(sql`
    ALTER TABLE alarms
    ADD COLUMN active_dedup_key VARCHAR(100)
      GENERATED ALWAYS AS (
        case when status in ('active','acknowledged')
          then concat(coalesce(rule_id,0), ':', coalesce(meter_id,0), ':', coalesce(gateway_id,0), ':', metric)
          else null end
      ) VIRTUAL
  `);
  await db.execute(sql`ALTER TABLE alarms ADD UNIQUE KEY alarms_active_dedup_uniq (active_dedup_key)`);
  console.log("migration applied: active_dedup_key + alarms_active_dedup_uniq");
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
