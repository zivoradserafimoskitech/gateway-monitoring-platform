// Unit tests for the telemetry BatchWriter durability controls (v5 #3).
import { test } from "vitest";
import assert from "node:assert/strict";
import { BatchWriter } from "../api/telemetry/index";
import type { TelemetryRow, TelemetryStore } from "../api/telemetry/types";

const row = (i: number): TelemetryRow => ({ meterId: i, ts: new Date(), values: { activePowerKw: i } });

function stubStore(fn: (rows: TelemetryRow[]) => Promise<void>): TelemetryStore {
  return {
    writeBatch: fn,
    latest: async () => null,
    latestAll: async () => new Map(),
    history: async () => [],
    powerTrend: async () => [],
    firstEnergySince: async () => null,
    firstEnergyAll: async () => new Map(),
    dailyReport: async () => [],
    close: async () => {},
  };
}

test("drain flushes everything queued (graceful shutdown)", async () => {
  const written: number[] = [];
  const w = new BatchWriter(stubStore(async (rows) => void written.push(...rows.map((r) => r.meterId))));
  for (let i = 0; i < 7; i++) w.push(row(i));
  await w.drain();
  assert.equal(written.length, 7);
  assert.equal(w.stats.queueLength, 0);
  assert.equal(w.stats.rowsWritten, 7);
});

test("failed batch is requeued and retried, not dropped on first failure", async () => {
  let calls = 0;
  const written: number[] = [];
  const w = new BatchWriter(
    stubStore(async (rows) => {
      calls++;
      if (calls < 3) throw new Error("db down");
      written.push(...rows.map((r) => r.meterId));
    }),
  );
  w.push(row(1));
  w.push(row(2));
  await w.flush(true); // attempt 1 fails → requeue + backoff
  assert.equal(w.stats.queueLength, 2);
  assert.equal(written.length, 0);
  await w.flush(true); // attempt 2 fails → still requeued
  assert.equal(w.stats.queueLength, 2);
  await w.flush(true); // attempt 3 succeeds
  assert.equal(written.length, 2);
  assert.equal(w.stats.retries, 2);
  assert.equal(w.stats.failed, 0);
});

test("poison batch is dropped only after RETRY_MAX attempts", async () => {
  const w = new BatchWriter(
    stubStore(async () => {
      throw new Error("syntax error");
    }),
  );
  w.push(row(9));
  for (let i = 0; i < 6; i++) await w.flush(true);
  assert.equal(w.stats.failed, 1); // 1 row dropped after 5 retries + final attempt
  assert.equal(w.stats.queueLength, 0);
});

test("backpressure: queue bounded at TELEMETRY_QUEUE_MAX, oldest dropped", async () => {
  // Store never resolves: the first BATCH_MAX rows are held by the hung
  // flush, everything beyond QUEUE_MAX after that must be dropped (oldest first).
  const w = new BatchWriter(stubStore(async () => new Promise(() => {})));
  for (let i = 0; i < 52_000; i++) w.push(row(i));
  assert.equal(w.stats.queueLength <= 50_000, true);
  assert.equal(w.stats.dropped >= 1, true);
});
