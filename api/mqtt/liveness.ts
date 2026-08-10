// Fleet-scale liveness tracking.
//
// The naive design — one UPDATE per meter per 30 s — costs meters/30 UPDATEs/s,
// which is 267/s at 8,000 meters and saturates the connection pool. Instead,
// "seen" timestamps accumulate in memory and are flushed every few seconds as
// a handful of bulk UPDATEs (one statement per 500 ids).
//
// v2 scale finding: even the bulk flush fell minutes behind at 500-gw load
// because EVERY seen device was rewritten EVERY flush (8,100 rows / 5 s).
// Now each device row is rewritten at most once per COALESCE_MS — liveness
// granularity is ~60 s, and flush volume drops ~12x at fleet scale.
import { inArray } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { gateways, meters } from "@db/schema";

const FLUSH_MS = 5_000;
const CHUNK = 500;
const COALESCE_MS = 60_000; // per-device min interval between liveness writes

const seenMeters = new Map<number, Date>();
const seenGateways = new Map<number, Date>();
const flushedMeters = new Map<number, number>();
const flushedGateways = new Map<number, number>();

let timer: NodeJS.Timeout | null = null;
let flushing = false;

export function markMeterSeen(meterId: number, at: Date): void {
  seenMeters.set(meterId, at);
  ensureTimer();
}

export function markGatewaySeen(gatewayId: number, at: Date): void {
  seenGateways.set(gatewayId, at);
  ensureTimer();
}

function ensureTimer(): void {
  if (timer) return;
  timer = setInterval(() => void flush(), FLUSH_MS);
  timer.unref?.();
}

async function flush(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    const db = getDb();
    const now = new Date();
    const nowMs = now.getTime();

    // Only rewrite devices not flushed within COALESCE_MS. Skipped devices must
    // KEEP their pending mark (v4 review #15): a device that reports once right
    // after a flush would otherwise lose its only liveness mark and stay
    // "offline" in the DB although it just reported.
    const meterIds = [...seenMeters.keys()].filter((id) => nowMs - (flushedMeters.get(id) ?? 0) > COALESCE_MS);
    if (meterIds.length > 0) {
      for (let i = 0; i < meterIds.length; i += CHUNK) {
        const chunk = meterIds.slice(i, i + CHUNK);
        await db
          .update(meters)
          .set({ status: "online", lastSeenAt: now })
          .where(inArray(meters.id, chunk));
        for (const id of chunk) {
          flushedMeters.set(id, nowMs);
          seenMeters.delete(id);
        }
      }
    }

    const gwIds = [...seenGateways.keys()].filter((id) => nowMs - (flushedGateways.get(id) ?? 0) > COALESCE_MS);
    if (gwIds.length > 0) {
      for (let i = 0; i < gwIds.length; i += CHUNK) {
        const chunk = gwIds.slice(i, i + CHUNK);
        await db
          .update(gateways)
          .set({ status: "online", lastSeenAt: now })
          .where(inArray(gateways.id, chunk));
        for (const id of chunk) {
          flushedGateways.set(id, nowMs);
          seenGateways.delete(id);
        }
      }
    }
  } catch (err) {
    console.error("[liveness] flush failed:", err instanceof Error ? err.message : err);
  } finally {
    flushing = false;
  }
}
