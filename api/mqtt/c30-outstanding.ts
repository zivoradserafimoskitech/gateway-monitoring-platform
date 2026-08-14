// Wave 4 / C30 T1+T4: outstanding-read correlation for the C30 transparent
// channel.
//
// A Modbus RTU RESPONSE carries no start address — only slave, function code,
// byte count and payload. To decode a response against a KNOWN base (instead
// of guessing the profile span), every solicited read the platform issues is
// registered here keyed on `${gatewayId}:${slave}:${fc}` with the requested
// start/quantity and a 30 s deadline. handleC30Frame matches a response when
// gateway+slave+fc match AND byteCount === quantity*2, then decodes with
// baseAddress = start.
//
// The same machinery gives C30 control writes a read-back confirmation (T4):
// an entry with `verifyExpected` compares the read-back register value against
// the written value and marks the control command row "ok"/"failed"; the sweep
// marks verify rows still "sent" after the deadline as failed.
//
// Principle (constraint #5): prefer dropping a frame over guessing at it.
import { eq } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { commands } from "@db/schema";

export const OUTSTANDING_TIMEOUT_MS = 30_000;

export interface OutstandingRead {
  gatewayId: number;
  slave: number;
  fc: 3 | 4;
  start: number;
  quantity: number; // registers
  deadline: number; // epoch ms
  /** commands row of the readNow request — stamped with respondedAt on match. */
  commandId?: number;
  /** T4: expected value of the written register (read-back verification). */
  verifyExpected?: number;
  /** T4: commands row of the CONTROL write — marked ok/failed on match/sweep. */
  verifyCommandId?: number;
}

// Keyed on `${gatewayId}:${slave}:${fc}`; the bucket holds one entry per
// in-flight read BLOCK (a per-block readNow issues several reads for the same
// slave/fc with different start/quantity — they must not overwrite each other).
const outstanding = new Map<string, OutstandingRead[]>();

function keyOf(gatewayId: number, slave: number, fc: number): string {
  return `${gatewayId}:${slave}:${fc}`;
}

export function registerOutstanding(
  entry: Omit<OutstandingRead, "deadline"> & { deadline?: number },
): OutstandingRead {
  const full: OutstandingRead = {
    ...entry,
    deadline: entry.deadline ?? Date.now() + OUTSTANDING_TIMEOUT_MS,
  };
  const key = keyOf(full.gatewayId, full.slave, full.fc);
  const bucket = outstanding.get(key) ?? [];
  bucket.push(full);
  outstanding.set(key, bucket);
  return full;
}

/**
 * Match an incoming response frame against the outstanding registry. A match
 * requires same gateway+slave+fc AND byteCount === quantity*2; expired entries
 * never match. A matched entry is consumed (single response per request).
 * Returns null when nothing matches — the caller then tries the unsolicited
 * (exactly-one-block) path or drops the frame.
 */
export function matchOutstanding(
  gatewayId: number,
  slave: number,
  fc: number,
  byteCount: number,
  now = Date.now(),
): OutstandingRead | null {
  const key = keyOf(gatewayId, slave, fc);
  const bucket = outstanding.get(key);
  if (!bucket) return null;
  const idx = bucket.findIndex((e) => e.deadline > now && e.quantity * 2 === byteCount);
  if (idx === -1) return null; // not our response — leave entries for the real one
  const [entry] = bucket.splice(idx, 1);
  if (bucket.length === 0) outstanding.delete(key);
  return entry;
}

/** T4: attach the control commands-row id once executeAndLog has inserted it. */
export function attachVerifyCommand(gatewayId: number, slave: number, fc: number, commandId: number): void {
  const bucket = outstanding.get(keyOf(gatewayId, slave, fc));
  const entry = bucket?.find((e) => e.verifyExpected !== undefined && e.verifyCommandId === undefined);
  if (entry) entry.verifyCommandId = commandId;
}

/** Remove expired entries and return them (deadline passed, never matched). */
export function sweepExpired(now = Date.now()): OutstandingRead[] {
  const expired: OutstandingRead[] = [];
  for (const [key, bucket] of outstanding) {
    const alive = bucket.filter((e) => e.deadline > now);
    expired.push(...bucket.filter((e) => e.deadline <= now));
    if (alive.length === 0) outstanding.delete(key);
    else if (alive.length !== bucket.length) outstanding.set(key, alive);
  }
  return expired;
}

/**
 * Sweep expired entries and fail their control command rows: a C30 write whose
 * read-back never arrived must not sit in "sent" forever (T4).
 * Returns the number of expired entries.
 */
export async function sweepOutstanding(now = Date.now()): Promise<number> {
  const expired = sweepExpired(now);
  const db = getDb();
  for (const entry of expired) {
    if (entry.verifyCommandId !== undefined) {
      await db
        .update(commands)
        .set({ status: "failed", result: "no read-back within 30s" })
        .where(eq(commands.id, entry.verifyCommandId));
    }
  }
  return expired.length;
}

/**
 * T4 match-side resolution: compare the read-back register value against the
 * written value and update the control command row. `observed` is the first
 * register of the response payload (quantity is always 1 for verify reads).
 */
export async function confirmVerifiedWrite(entry: OutstandingRead, observed: number): Promise<void> {
  const ok = observed === entry.verifyExpected;
  if (entry.verifyCommandId === undefined) return; // row id not attached yet (shouldn't happen)
  const db = getDb();
  await db
    .update(commands)
    .set({
      status: ok ? "ok" : "failed",
      result: ok
        ? `read-back verified: register ${entry.start} = ${observed}`
        : `read-back mismatch: register ${entry.start} reads ${observed}, expected ${entry.verifyExpected}`,
      respondedAt: new Date(),
    })
    .where(eq(commands.id, entry.verifyCommandId));
}

/** Stamp the readNow command row whose response just arrived (T1a). */
export async function stampResponded(commandId: number): Promise<void> {
  const db = getDb();
  await db.update(commands).set({ respondedAt: new Date() }).where(eq(commands.id, commandId));
}

/** Test hook: clear the registry between tests. */
export function clearOutstanding(): void {
  outstanding.clear();
}

/** Test/inspection hook: total number of outstanding entries across buckets. */
export function outstandingSize(): number {
  let n = 0;
  for (const bucket of outstanding.values()) n += bucket.length;
  return n;
}
