// Telemetry store factory + batched ingestion writer.
//
// The batch writer is the single most important piece for scale: at 500 gateways
// × 16 meters × 1 msg/min the platform receives ~135 samples/s. Writing each one
// individually costs 135 transactions/s; batching them into 1–2 multi-row INSERTs
// per second reduces that by two orders of magnitude and keeps the broker-facing
// path non-blocking (MQTT messages are acked immediately).
import { MySqlTelemetryStore } from "./mysql-store";
import { TimescaleTelemetryStore } from "./timescale-store";
import type { TelemetryRow, TelemetryStore } from "./types";

declare global {
  // eslint-disable-next-line no-var
  var __telemetryStore: TelemetryStore | undefined;
  // eslint-disable-next-line no-var
  var __telemetryWriter: BatchWriter | undefined;
}

export function getTelemetryStore(): TelemetryStore {
  if (globalThis.__telemetryStore) return globalThis.__telemetryStore;
  const kind = process.env.TELEMETRY_STORE || (process.env.TIMESCALE_URL ? "timescale" : "mysql");
  if (kind === "timescale") {
    if (!process.env.TIMESCALE_URL) throw new Error("TIMESCALE_URL is required for the timescale store");
    globalThis.__telemetryStore = new TimescaleTelemetryStore(process.env.TIMESCALE_URL);
    console.log("[telemetry] using TimescaleDB store");
  } else {
    globalThis.__telemetryStore = new MySqlTelemetryStore();
    console.log("[telemetry] using MySQL store");
  }
  return globalThis.__telemetryStore;
}

const FLUSH_MS = parseInt(process.env.TELEMETRY_FLUSH_MS || "1000", 10);
const BATCH_MAX = parseInt(process.env.TELEMETRY_BATCH_MAX || "1000", 10);

export interface WriterStats {
  rowsWritten: number;
  flushes: number;
  failed: number;
  queueLength: number;
  lastFlushMs: number | null;
  lastError: string | null;
}

class BatchWriter {
  private queue: TelemetryRow[] = [];
  private timer: NodeJS.Timeout;
  private flushing = false;
  private store: TelemetryStore;
  readonly stats: WriterStats = {
    rowsWritten: 0,
    flushes: 0,
    failed: 0,
    queueLength: 0,
    lastFlushMs: null,
    lastError: null,
  };

  constructor(store: TelemetryStore) {
    this.store = store;
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
    this.timer.unref?.();
  }

  push(row: TelemetryRow): void {
    this.queue.push(row);
    this.stats.queueLength = this.queue.length;
    if (this.queue.length >= BATCH_MAX) void this.flush();
  }

  async flush(): Promise<void> {
    if (this.flushing || this.queue.length === 0) return;
    this.flushing = true;
    const batch = this.queue.splice(0, BATCH_MAX);
    const started = Date.now();
    try {
      await this.store.writeBatch(batch);
      this.stats.rowsWritten += batch.length;
      this.stats.flushes++;
      this.stats.lastFlushMs = Date.now() - started;
    } catch (err) {
      this.stats.failed += batch.length;
      this.stats.lastError = err instanceof Error ? err.message : String(err);
      console.error(`[telemetry] batch write failed (${batch.length} rows):`, this.stats.lastError);
    } finally {
      this.stats.queueLength = this.queue.length;
      this.flushing = false;
    }
  }
}

export function getTelemetryWriter(): BatchWriter {
  if (!globalThis.__telemetryWriter) {
    globalThis.__telemetryWriter = new BatchWriter(getTelemetryStore());
  }
  return globalThis.__telemetryWriter;
}

export function getTelemetryStats(): WriterStats & { store: string } {
  const writer = getTelemetryWriter();
  return {
    ...writer.stats,
    store: process.env.TELEMETRY_STORE || (process.env.TIMESCALE_URL ? "timescale" : "mysql"),
  };
}
