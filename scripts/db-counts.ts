import "dotenv/config";
import { getDb } from "../api/queries/connection";
import { sql } from "drizzle-orm";
async function main() {
  const db = getDb();
  const m = (await db.execute(sql`select count(*) as c from meters`)) as unknown as [Array<{ c: number }>];
  const t = (await db.execute(sql`select count(*) as c from telemetry`)) as unknown as [Array<{ c: number }>];
  const g = (await db.execute(sql`select count(*) as c from gateways`)) as unknown as [Array<{ c: number }>];
  console.log(`gateways: ${g[0][0].c}  meters: ${m[0][0].c}  telemetry: ${t[0][0].c}`);
  process.exit(0);
}
main();
