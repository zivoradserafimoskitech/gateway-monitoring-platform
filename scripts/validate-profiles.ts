// C4 deep check: every seeded profile register map parses; every def is well-formed.
import "dotenv/config";
import { getDb } from "../api/queries/connection";
import { deviceProfiles } from "../db/schema";

async function main() {
  const db = getDb();
  const rows = await db.select().from(deviceProfiles);
  let bad = 0;
  for (const r of rows) {
    const map = (typeof r.registerMap === "string" ? JSON.parse(r.registerMap as string) : r.registerMap) as any[];
    if (!Array.isArray(map) || map.length === 0) { console.log(`BAD ${r.model}: empty map`); bad++; continue; }
    for (const d of map) {
      const ok = typeof d.key === "string" && d.key.length > 0 && d.key.length <= 64
        && Number.isInteger(d.address) && d.address >= 0 && d.address <= 65535
        && (d.functionCode === 3 || d.functionCode === 4)
        && ["u16", "i16", "u32", "i32", "float32"].includes(d.type)
        && typeof d.scale === "number" && d.scale !== 0
        && (d.offset === undefined || typeof d.offset === "number")
        && (d.addressStride === undefined
          || (Number.isInteger(d.addressStride.firstUnit) && d.addressStride.firstUnit >= 1
            && Number.isInteger(d.addressStride.stride) && d.addressStride.stride > 0
            // worst-case shifted address must stay within 16-bit PDU space
            && d.address + 19 * d.addressStride.stride <= 65535));
      if (!ok) { console.log(`BAD ${r.model}: ${JSON.stringify(d)}`); bad++; }
    }
  }
  console.log(`validated ${rows.length} profiles, ${bad} bad register defs`);
  process.exit(bad ? 1 : 0);
}
main().catch((e) => { console.error(e); process.exit(1); });
