// One-off verifier for C3 (migration columns) and C4 (seeded profile counts).
import "dotenv/config";
import { getDb } from "../api/queries/connection";
import { sql } from "drizzle-orm";

async function main() {
  const db = getDb();
  const cols = (await db.execute(sql`
    select table_name, column_name from information_schema.columns
    where table_schema = database() and (
      (table_name='meters' and column_name in ('device_type','brand','host','port','unit_id','poll_interval_sec'))
      or (table_name='telemetry' and column_name='values_json')
      or (table_name='device_profiles' and column_name in ('brand','device_type','protocol','source','source_url','notes','fault_codes'))
    )`)) as unknown as [Array<{ table_name: string; column_name: string }>];
  console.log(`C3 columns present: ${cols[0].length}/14`);
  for (const c of cols[0]) console.log(`   ${c.table_name}.${c.column_name}`);

  const profs = (await db.execute(
    sql`select device_type, count(*) as c from device_profiles group by device_type order by device_type`,
  )) as unknown as [Array<{ device_type: string; c: number }>];
  console.log("C4 profiles by type:", JSON.stringify(profs[0]));
  const src = (await db.execute(
    sql`select source, count(*) as c from device_profiles where device_type in ('inverter','bess') group by source order by source`,
  )) as unknown as [Array<{ source: string; c: number }>];
  console.log("C4 profile sources:", JSON.stringify(src[0]));
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
