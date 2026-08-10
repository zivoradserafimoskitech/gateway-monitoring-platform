// v6/R7: add meters.site_id (+ index) idempotently.
import { getDb } from "../api/queries/connection";
import { sql } from "drizzle-orm";

async function main() {
  const db = getDb();
  const cols = await db.execute(sql`
    select column_name from information_schema.columns
    where table_schema = database() and table_name = 'meters' and column_name = 'site_id'`);
  const colRows = (cols as unknown as [Record<string, unknown>[]])[0];
  if (colRows.length === 0) {
    await db.execute(sql`alter table meters add site_id bigint unsigned`);
    console.log("added meters.site_id");
  } else {
    console.log("meters.site_id already present");
  }
  const idx = await db.execute(sql`
    select index_name from information_schema.statistics
    where table_schema = database() and table_name = 'meters' and index_name = 'meters_site_idx'`);
  const idxRows = (idx as unknown as [Record<string, unknown>[]])[0];
  if (idxRows.length === 0) {
    await db.execute(sql`create index meters_site_idx on meters (site_id)`);
    console.log("added meters_site_idx");
  } else {
    console.log("meters_site_idx already present");
  }
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
