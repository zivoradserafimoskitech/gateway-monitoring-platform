import "dotenv/config";
import { getDb } from "../api/queries/connection";
import { sql } from "drizzle-orm";
async function main() {
  const db = getDb();
  const r = await db.execute(sql`select m.id, m.name, m.site_id as ms, g.id as gid, g.site_id as gs from meters m join gateways g on g.id = m.gateway_id where m.site_id = 1 or g.site_id = 1`);
  console.log("site1 meters:", JSON.stringify(r[0]));
  const g2 = await db.execute(sql`select id, uid, site_id from gateways`);
  console.log("gateways:", JSON.stringify(g2[0]));
  process.exit(0);
}
main().catch((e) => { console.error(e); process.exit(1); });
