// Telemetry store factory + batched ingestion writer.
//
// The batch writer is the single most important piece for scale: at 500 gateways
// × 16 meters × 1 msg/min the platform receives ~135 samples/s. Writing each one
// individually costs 135 transactions/s; batching them into 1–2 multi-row INSERTs
// per second reduces that by two orders of magnitude and keeps the broker-facing
// path non-blocking (MQTT messages are acked immediately).
import fs from "node:fs";
import path from "node:path";
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
// v5 finding #3: durability controls — bounded queue (backpressure), retry
// with exponential backoff, and a drain on shutdown so the in-memory queue
// isn't lost on deploy/restart.
const QUEUE_MAX = parseInt(process.env.TELEMETRY_QUEUE_MAX || "50000", 10);
const RETRY_MAX = parseInt(process.env.TELEMETRY_RETRY_MAX || "5", 10);
const DRAIN_TIMEOUT_MS = parseInt(process.env.TELEMETRY_DRAIN_MS || "10000", 10);

export interface WriterStats {
  rowsWritten: number;
  flushes: number;
  failed: number;
  dropped: number;
  retries: number;
  queueLength: number;
  lastFlushMs: number | null;
  lastError: string | null;
}

// v7/C6: write-ahead log for the ingestion queue. Every pushed row is
// appended synchronously to pending.jsonl BEFORE it reaches the in-memory
// queue; at flush the pending segment is rotated to f-<ts>-<seq>.jsonl and
// only deleted after the DB insert succeeds. On boot, leftover f-*.jsonl
// segments are replayed — a crash/restart loses nothing queued. Semantics are
// at-least-once: a crash between a successful insert and the segment unlink
// can replay a few rows (telemetry has no unique constraint — acceptable and
// bounded to one segment).
interface WalBatch {
  rows: TelemetryRow[];
  walFile: string | null;
}

// Exported for unit tests (tests/batch-writer.test.ts).
export class BatchWriter {
  private queue: WalBatch[] = [];
  private pendingRows: TelemetryRow[] = [];
  private timer: NodeJS.Timeout;
  private flushing = false;
  private headAttempts = 0; // retries spent on the current head batch
  private nextFlushAt = 0; // backoff: don't hammer a down database
  private store: TelemetryStore;
  private walDir: string;
  private walSeq = 0;
  readonly stats: WriterStats = {
    rowsWritten: 0,
    flushes: 0,
    failed: 0,
    dropped: 0,
    retries: 0,
    queueLength: 0,
    lastFlushMs: null,
    lastError: null,
  };

  constructor(store: TelemetryStore, opts?: { walDir?: string }) {
    this.store = store;
    // opt-out with TELEMETRY_WAL_DIR="" (unit tests); default on for the app.
    this.walDir = opts?.walDir ?? "";
    if (this.walDir) {
      fs.mkdirSync(this.walDir, { recursive: true });
      // Rotate any pending segment left by a crash so replays never race with
      // new appends (replayWal handles every f-*.jsonl).
      const pending = path.join(this.walDir, "pending.jsonl");
      if (fs.existsSync(pending) && fs.statSync(pending).size > 0) {
        fs.renameSync(pending, this.walFileName());
      } else if (fs.existsSync(pending)) {
        fs.unlinkSync(pending);
      }
    }
    this.timer = setInterval(() => void this.flush(), FLUSH_MS);
    this.timer.unref?.();
  }

  private walFileName(): string {
    return path.join(this.walDir, `f-${Date.now()}-${this.walSeq++}.jsonl`);
  }

  private walAppend(row: TelemetryRow): void {
    const line = JSON.stringify({ ...row, ts: row.ts.toISOString() }) + "\n";
    try {
      fs.appendFileSync(path.join(this.walDir, "pending.jsonl"), line);
    } catch (err) {
      // Self-heal a vanished WAL dir (observed once in the sandbox when the
      // overlay fs dropped the directory mid-run): recreate and retry once.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        try {
          fs.mkdirSync(this.walDir, { recursive: true });
          fs.appendFileSync(path.join(this.walDir, "pending.jsonl"), line);
          return;
        } catch {
          /* fall through to the log line */
        }
      }
      // WAL failure must not break ingestion — the in-memory path still works.
      console.error("[telemetry] WAL append failed:", err instanceof Error ? err.message : err);
    }
  }

  private totalQueued(): number {
    return this.pendingRows.length + this.queue.reduce((n, b) => n + b.rows.length, 0);
  }

  push(row: TelemetryRow): void {
    // Backpressure: past QUEUE_MAX, drop the OLDEST rows (fresh data is more
    // valuable for monitoring) and count them so the loss is observable.
    if (this.totalQueued() >= QUEUE_MAX) {
      this.stats.dropped++;
      if (this.pendingRows.length > 0) this.pendingRows.shift();
      else this.queue[0]?.rows.shift();
    }
    if (this.walDir) this.walAppend(row);
    this.pendingRows.push(row);
    this.stats.queueLength = this.totalQueued();
    if (this.pendingRows.length >= BATCH_MAX) void this.flush();
  }

  /** Move pendingRows (+ their WAL segment) into the flush queue. */
  private rotatePending(): void {
    if (this.pendingRows.length === 0) return;
    let walFile: string | null = null;
    if (this.walDir) {
      const pending = path.join(this.walDir, "pending.jsonl");
      walFile = this.walFileName();
      try {
        if (fs.existsSync(pending)) fs.renameSync(pending, walFile);
        else walFile = null; // WAL appends were failing — in-memory only
      } catch (err) {
        console.error("[telemetry] WAL rotate failed:", err instanceof Error ? err.message : err);
        walFile = null;
      }
    }
    this.queue.push({ rows: this.pendingRows.splice(0), walFile });
  }

  async flush(force = false): Promise<void> {
    if (this.flushing) return;
    this.rotatePending();
    if (this.queue.length === 0) return;
    if (!force && Date.now() < this.nextFlushAt) return;
    this.flushing = true;
    const batch = this.queue[0];
    const rows = batch.rows.slice(0, BATCH_MAX);
    const started = Date.now();
    try {
      await this.store.writeBatch(rows);
      this.headAttempts = 0;
      this.nextFlushAt = 0;
      this.stats.rowsWritten += rows.length;
      this.stats.flushes++;
      this.stats.lastFlushMs = Date.now() - started;
      batch.rows = batch.rows.slice(rows.length);
      if (batch.rows.length === 0) {
        this.queue.shift();
        if (batch.walFile) {
          try {
            fs.unlinkSync(batch.walFile);
          } catch {
            /* already gone — fine */
          }
        }
      }
    } catch (err) {
      this.headAttempts++;
      this.stats.lastError = err instanceof Error ? err.message : String(err);
      if (this.headAttempts > RETRY_MAX) {
        // Poison batch or a multi-minute outage: the WAL SEGMENT SURVIVES, so
        // unlike the pre-C6 in-memory queue these rows are not lost — they
        // replay on next boot. Give up on them only in this process.
        this.stats.failed += batch.rows.length;
        this.headAttempts = 0;
        this.queue.shift();
        console.error(
          `[telemetry] batch gave up after ${RETRY_MAX} retries (${batch.rows.length} rows) — kept in WAL${batch.walFile ? ` ${batch.walFile}` : ""}: ${this.stats.lastError}`,
        );
      } else {
        // Back off: 2s, 4s, 8s … capped at 30s. Batch stays at the head.
        this.stats.retries++;
        this.nextFlushAt = Date.now() + Math.min(30_000, 1000 * 2 ** this.headAttempts);
        console.error(
          `[telemetry] batch write failed (attempt ${this.headAttempts}/${RETRY_MAX}, ${batch.rows.length} rows kept): ${this.stats.lastError}`,
        );
      }
    } finally {
      this.stats.queueLength = this.totalQueued();
      this.flushing = false;
    }
  }

  /**
   * Replay leftover WAL segments from a previous process (crash/restart).
   * Fire-and-forget at boot; segments that fail to replay stay on disk for
   * the next boot.
   */
  async replayWal(): Promise<{ segments: number; rows: number }> {
    if (!this.walDir) return { segments: 0, rows: 0 };
    let segments = 0;
    let rowsTotal = 0;
    const files = fs
      .readdirSync(this.walDir)
      .filter((f) => /^f-\d+-\d+\.jsonl$/.test(f))
      .sort();
    for (const f of files) {
      const fp = path.join(this.walDir, f);
      try {
        const lines = fs.readFileSync(fp, "utf8").split("\n").filter(Boolean);
        const rows = lines.map((l) => {
          const r = JSON.parse(l) as TelemetryRow & { ts: string };
          return { ...r, ts: new Date(r.ts) } as TelemetryRow;
        });
        if (rows.length === 0) {
          try {
            fs.unlinkSync(fp);
          } catch {
            /* a concurrent replayer already removed it — fine */
          }
          continue;
        }
        await this.store.writeBatch(rows);
        try {
          fs.unlinkSync(fp);
        } catch {
          /* concurrent replayer won the unlink — the write succeeded, continue */
        }
        segments++;
        rowsTotal += rows.length;
      } catch (err) {
        console.error(`[telemetry] WAL replay stopped at ${f}:`, err instanceof Error ? err.message : err);
        break; // DB down or a poison segment — retry on next boot
      }
    }
    if (rowsTotal > 0) console.log(`[telemetry] WAL replay: ${rowsTotal} rows from ${segments} segment(s)`);
    return { segments, rows: rowsTotal };
  }

  /** Best-effort flush of everything queued, for graceful shutdown. */
  async drain(timeoutMs = DRAIN_TIMEOUT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.totalQueued() > 0 && Date.now() < deadline) {
      const before = this.totalQueued();
      await this.flush(true);
      if (this.totalQueued() === before) {
        // No progress (store still failing) — waiting won't help within budget
        await new Promise((r) => setTimeout(r, 250));
        if (this.headAttempts > 1) break;
      }
    }
  }
}

let shutdownHooked = false;
function hookShutdownDrain(writer: BatchWriter): void {
  if (shutdownHooked) return;
  shutdownHooked = true;
  const onSignal = (sig: string) => {
    console.log(`[telemetry] ${sig} received — draining ${writer.stats.queueLength} queued rows`);
    const hardExit = setTimeout(() => process.exit(1), DRAIN_TIMEOUT_MS + 3000);
    hardExit.unref?.();
    void writer.drain().then(() => {
      clearTimeout(hardExit);
      console.log("[telemetry] drain complete");
      process.exit(0);
    });
  };
  process.once("SIGTERM", () => onSignal("SIGTERM"));
  process.once("SIGINT", () => onSignal("SIGINT"));
}

export function getTelemetryWriter(): BatchWriter {
  if (!globalThis.__telemetryWriter) {
    // v7/C6: WAL dir — set TELEMETRY_WAL_DIR="" to disable (unit tests).
    const walDir =
      process.env.TELEMETRY_WAL_DIR === ""
        ? ""
        : process.env.TELEMETRY_WAL_DIR || path.join(process.cwd(), "data", "wal");
    globalThis.__telemetryWriter = new BatchWriter(getTelemetryStore(), { walDir });
    hookShutdownDrain(globalThis.__telemetryWriter);
    // Replay segments left by a previous crash/restart before serving new data.
    void globalThis.__telemetryWriter.replayWal();
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
