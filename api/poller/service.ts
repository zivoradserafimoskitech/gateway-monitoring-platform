// Modbus TCP poller — for devices reachable directly over Ethernet/WiFi
// (inverters with LAN dongles, BESS controllers, GX devices, ...), no Enertrek
// gateway needed. Devices are regular rows in `meters` with host/port set.
//
// Design notes:
// - One TCP client per host:port, unit-ID addressing per device (Modbus TCP
//   gateways commonly route multiple unit IDs over one socket).
// - Per-device independent poll loop at meters.pollIntervalSec with backoff.
// - Registers are grouped into read blocks (same function code, gap ≤ 8,
//   ≤ 120 words) so sparse vendor maps cost 1–3 round trips, not one per key.
// - Decoded values go through the SAME hot path as gateway traffic
//   (persistTelemetry → batch writer + liveness + alarm rules).
import ModbusRTU from "modbus-serial";
import { isNotNull } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { meters } from "@db/schema";
import type { Meter } from "@db/schema";
import type { RegisterDef } from "@contracts/modbus";
import { getRegisterMaps, persistTelemetry } from "../mqtt/handlers";
import { decodeRegisters } from "../modbus";
import { shiftedAddress } from "@contracts/modbus";
import { isTransportError, nextBackoffMs } from "./backoff";

const REFRESH_MS = 30_000;
const MAX_BLOCK_WORDS = 120; // Modbus spec limit is 125 registers per read
const MAX_GAP_WORDS = 8;

interface Block {
  functionCode: 3 | 4;
  start: number; // PDU address
  words: number;
  defs: RegisterDef[];
}

// Group a register map into minimal read blocks.
export function buildBlocks(map: RegisterDef[]): Block[] {
  const wordsOf = (t: RegisterDef["type"]) => (t === "float32" || t === "u32" || t === "i32" ? 2 : 1);
  const blocks: Block[] = [];
  for (const fc of [3, 4] as const) {
    const defs = map
      .filter((d) => d.functionCode === fc)
      .sort((a, b) => a.address - b.address);
    let cur: Block | null = null;
    for (const def of defs) {
      const w = wordsOf(def.type);
      const end = def.address + w;
      if (cur && def.address - (cur.start + cur.words) <= MAX_GAP_WORDS && end - cur.start <= MAX_BLOCK_WORDS) {
        cur.words = end - cur.start;
        cur.defs.push(def);
      } else {
        cur = { functionCode: fc, start: def.address, words: w, defs: [def] };
        blocks.push(cur);
      }
    }
  }
  return blocks;
}

interface DeviceStats {
  polls: number;
  failures: number;
  lastOkAt: Date | null;
  lastError: string | null;
}

interface Task {
  device: Meter; // refreshed on each supervisor pass
  stopped: boolean;
  timer: NodeJS.Timeout | null;
  backoffMs: number;
  stats: DeviceStats;
}

interface ConnEntry {
  client: ModbusRTU;
  busy: boolean;
}

const tasks = new Map<number, Task>();
const conns = new Map<string, ConnEntry>();
let refreshTimer: NodeJS.Timeout | null = null;
let started = false;

function connKey(host: string, port: number): string {
  return `${host}:${port}`;
}

// In-flight connect attempts, keyed like `conns` — concurrent first polls of
// devices sharing one host:port must await the SAME connect, not each open
// their own socket (v4 finding #11: the losing socket leaked).
const pendingConns = new Map<string, Promise<ConnEntry>>();

async function getConn(host: string, port: number): Promise<ConnEntry> {
  const key = connKey(host, port);
  const existing = conns.get(key);
  if (existing && existing.client.isOpen) return existing;
  const inflight = pendingConns.get(key);
  if (inflight) return inflight;
  const attempt = (async (): Promise<ConnEntry> => {
    const client = new ModbusRTU();
    client.setTimeout(8000);
    await client.connectTCP(host, { port });
    const entry: ConnEntry = { client, busy: false };
    conns.set(key, entry);
    return entry;
  })();
  pendingConns.set(key, attempt);
  try {
    return await attempt;
  } finally {
    pendingConns.delete(key);
  }
}

function dropConn(key: string): void {
  const e = conns.get(key);
  if (e) {
    try {
      e.client.close(() => undefined);
    } catch {
      /* ignore */
    }
    conns.delete(key);
  }
}

async function pollDevice(task: Task): Promise<void> {
  const dev = task.device;
  const host = dev.host!;
  const port = dev.port ?? 502;

  const maps = await getRegisterMaps();
  const map = maps.get(dev.model);
  if (!map || map.length === 0) throw new Error(`no register map for model '${dev.model}'`);
  // Multi-object devices (e.g. ESMU ESBCM strings): shift block addresses per unit.
  const unitId = dev.unitId ?? dev.modbusAddress;
  const shifted = map.some((d) => d.addressStride)
    ? map.map((d) => ({ ...d, address: shiftedAddress(d, unitId) }))
    : map;
  const blocks = buildBlocks(shifted);

  const entry = await getConn(host, port);
  // Serialize access per socket: wait for the slot, but bounded — a stuck
  // holder must not spin us forever (v4 finding #12).
  const busyDeadline = Date.now() + 15_000;
  while (entry.busy) {
    if (Date.now() > busyDeadline) throw new Error("socket busy >15s (concurrent poll stuck)");
    await new Promise((r) => setTimeout(r, 50));
  }
  entry.busy = true;
  try {
    entry.client.setID(dev.unitId ?? dev.modbusAddress);
    const values: Record<string, number> = {};
    for (const block of blocks) {
      const res =
        block.functionCode === 3
          ? await entry.client.readHoldingRegisters(block.start, block.words)
          : await entry.client.readInputRegisters(block.start, block.words);
      Object.assign(values, decodeRegisters(block.defs, res.buffer, block.start));
    }
    if (Object.keys(values).length > 0) {
      await persistTelemetry(dev, values, { poller: "tcp", host, port });
    }
    task.stats.polls++;
    task.stats.lastOkAt = new Date();
    task.stats.lastError = null;
    task.backoffMs = 0;
  } finally {
    entry.busy = false;
  }
}

function scheduleNext(task: Task): void {
  if (task.stopped) return;
  const interval = Math.max(5, task.device.pollIntervalSec || 60) * 1000;
  const delay = task.backoffMs > 0 ? task.backoffMs : interval;
  task.timer = setTimeout(() => void runTask(task), delay);
  task.timer.unref?.();
}

async function runTask(task: Task): Promise<void> {
  if (task.stopped) return;
  try {
    await pollDevice(task);
  } catch (err) {
    task.stats.failures++;
    task.stats.lastError = err instanceof Error ? err.message : String(err);
    // Exponential backoff capped at 5 min. Drop the shared socket ONLY on
    // transport-level failures — a device-level error (bad register, one dead
    // unit) must not disconnect the other units sharing host:port (#10).
    task.backoffMs = nextBackoffMs(task.backoffMs);
    if (isTransportError(err)) {
      dropConn(connKey(task.device.host!, task.device.port ?? 502));
    }
  }
  scheduleNext(task);
}

function sameConfig(a: Meter, b: Meter): boolean {
  return (
    a.host === b.host &&
    a.port === b.port &&
    a.modbusAddress === b.modbusAddress &&
    a.unitId === b.unitId &&
    a.model === b.model &&
    a.pollIntervalSec === b.pollIntervalSec
  );
}

async function refreshDevices(): Promise<void> {
  const db = getDb();
  let rows: Meter[] = [];
  try {
    rows = await db.select().from(meters).where(isNotNull(meters.host));
  } catch (err) {
    console.error("[poller] device refresh failed:", err instanceof Error ? err.message : err);
    return;
  }
  const seen = new Set<number>();
  for (const dev of rows) {
    seen.add(dev.id);
    const existing = tasks.get(dev.id);
    if (existing) {
      if (!sameConfig(existing.device, dev)) {
        existing.device = dev; // next poll picks up new config
        existing.backoffMs = 0;
      }
    } else {
      const task: Task = {
        device: dev,
        stopped: false,
        timer: null,
        backoffMs: 0,
        stats: { polls: 0, failures: 0, lastOkAt: null, lastError: null },
      };
      tasks.set(dev.id, task);
      // Stagger first polls to avoid a thundering herd on startup
      task.timer = setTimeout(() => void runTask(task), (dev.id % 20) * 250);
      task.timer.unref?.();
    }
  }
  for (const [id, task] of tasks) {
    if (!seen.has(id)) {
      task.stopped = true;
      if (task.timer) clearTimeout(task.timer);
      tasks.delete(id);
    }
  }
}

export function startPollerService(): void {
  if (started) return;
  if (process.env.POLLER_ENABLED === "0") {
    console.log("[poller] disabled via POLLER_ENABLED=0");
    return;
  }
  started = true;
  void refreshDevices();
  refreshTimer = setInterval(() => void refreshDevices(), REFRESH_MS);
  refreshTimer.unref?.();
  console.log("[poller] Modbus TCP poller started");
}

export function getPollerStatus() {
  return {
    running: started,
    devices: [...tasks.values()].map((t) => ({
      id: t.device.id,
      name: t.device.name,
      host: t.device.host,
      port: t.device.port ?? 502,
      unitId: t.device.unitId ?? t.device.modbusAddress,
      model: t.device.model,
      intervalSec: t.device.pollIntervalSec,
      polls: t.stats.polls,
      failures: t.stats.failures,
      lastOkAt: t.stats.lastOkAt,
      lastError: t.stats.lastError,
      backoffMs: t.backoffMs,
    })),
  };
}
