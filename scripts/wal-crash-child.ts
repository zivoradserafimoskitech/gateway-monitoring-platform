// v7/C6 probe helper: simulates a crash — pushes rows to a WAL-backed writer
// and exits HARD before the 1s flush timer fires (no drain, no flush).
import "dotenv/config";
import { getTelemetryStore, BatchWriter } from "../api/telemetry";

async function main() {
  const meterId = Number(process.argv[2]);
  const walDir = process.argv[3];
  const writer = new BatchWriter(getTelemetryStore(), { walDir });
  const base = new Date("2026-08-10T10:00:00Z").getTime();
  for (let i = 0; i < 3; i++) {
    writer.push({ meterId, ts: new Date(base + i * 60_000), values: { energyImportKwh: 500 + i } });
  }
  await new Promise((r) => setTimeout(r, 300));
  process.exit(0); // simulated crash: timer (1s) never fired, no drain
}
main();
