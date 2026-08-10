// C9 verification: existing demo meters + new PV devices online with fresh data.
import "dotenv/config";
import { getDb } from "../api/queries/connection";
import { meters } from "../db/schema";
import { getTelemetryStore } from "../api/telemetry";


async function main() {
  const db = getDb();
  const rows = await db.select().from(meters);
  const store = getTelemetryStore();
  const t0 = performance.now();
  const all = await store.latestAll();
  const ms = Math.round(performance.now() - t0);
  console.log(`devices: ${rows.length}, latestAll: ${all.size} in ${ms}ms`);
  for (const r of rows) {
    const l = all.get(r.id);
    const ageSec = l ? Math.round((Date.now() - new Date(l.at).getTime()) / 1000) : -1;
    const keys = l ? Object.keys(l.values).length : 0;
    const sample = l
      ? Object.entries(l.values).slice(0, 3).map(([k, v]) => `${k}=${typeof v === "number" ? v.toFixed(2) : v}`).join(" ")
      : "-";
    console.log(`  [${r.status.padEnd(7)}] ${r.name.padEnd(26)} ${r.deviceType.padEnd(8)} age=${String(ageSec).padStart(4)}s keys=${String(keys).padStart(2)} ${sample}`);
  }
  await store.close();
  process.exit(0);
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
