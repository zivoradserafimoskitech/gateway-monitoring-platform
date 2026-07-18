// Fleet-scale liveness tracking.
//
// The naive design — one UPDATE per meter per 30 s — costs meters/30 UPDATEs/s,
// which is 267/s at 8,000 meters and saturates the connection pool. Instead,
// "seen" timestamps accumulate in memory and are flushed every few seconds as
// a handful of bulk UPDATEs (one statement per 500 ids), so liveness costs
// O(1) queries regardless of fleet size.
import { inArray } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { gateways, meters } from "@db/schema";

const FLUSH_MS = 5_000;
const CHUNK = 500;

const seenMeters = new Map<number, Date>();
const seenGateways = new Map<number, Date>();

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

    const meterIds = [...seenMeters.keys()];
    if (meterIds.length > 0) {
      for (let i = 0; i < meterIds.length; i += CHUNK) {
        const chunk = meterIds.slice(i, i + CHUNK);
        await db
          .update(meters)
          .set({ status: "online", lastSeenAt: now })
          .where(inArray(meters.id, chunk));
      }
      seenMeters.clear();
    }

    const gwIds = [...seenGateways.keys()];
    if (gwIds.length > 0) {
      for (let i = 0; i < gwIds.length; i += CHUNK) {
        const chunk = gwIds.slice(i, i + CHUNK);
        await db
          .update(gateways)
          .set({ status: "online", lastSeenAt: now })
          .where(inArray(gateways.id, chunk));
      }
      seenGateways.clear();
    }
  } catch (err) {
    console.error("[liveness] flush failed:", err instanceof Error ? err.message : err);
  } finally {
    flushing = false;
  }
}
