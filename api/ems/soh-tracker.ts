// §9.5: the sweep that turns telemetry into battery health.
//
// The decisions are pure and live in ./soh.ts. This walks each battery's
// samples forward from a stored cursor, feeds them through those functions,
// and persists the result.
//
// Cursor-based rather than "read the last N minutes": a restart, a slow tick
// or a backfill must not double-count throughput or skip a stretch, and both
// mistakes are invisible in the output — they just quietly make a battery look
// more or less worn than it is.
import { eq, inArray, sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { batteryCapacityEstimates, batteryHealth, meters } from "@db/schema";
import { withLease } from "../lib/leader";
import {
  blendSoh,
  capacityFromWindow,
  efcDelta,
  sohPercent,
  throughputDelta,
  windowStep,
  type SocSample,
  type WindowState,
} from "./soh";

const SWEEP_MS = 5 * 60_000;
/** Samples processed per battery per sweep. Bounded so a long backlog is
 *  worked off over several ticks instead of in one very long query. */
const PAGE = 5_000;

interface HealthRow {
  meterId: number;
  nameplateKwh: number | null;
  efc: number;
  throughputDischargedKwh: number;
  throughputChargedKwh: number;
  sohPct: number | null;
  sohSamples: number;
  lastTs: Date | null;
  lastSocPct: number | null;
  lastPowerKw: number | null;
  windowSocStart: number | null;
  windowKwh: number | null;
  orgId: number | null;
}

/** Read one battery's new samples. SoC and battery power live in values_json
 *  for BESS profiles, which is why this is raw SQL rather than a column read. */
async function loadSamples(meterId: number, after: Date | null, limit: number): Promise<SocSample[]> {
  const db = getDb();
  const rows = await db
    .execute(
      after
        ? sql`select ts,
                     json_extract(values_json, '$.socPercent') as soc,
                     json_extract(values_json, '$.batteryPowerKw') as pwr
              from telemetry where meter_id = ${meterId} and ts > ${after}
              order by ts asc limit ${limit}`
        : sql`select ts,
                     json_extract(values_json, '$.socPercent') as soc,
                     json_extract(values_json, '$.batteryPowerKw') as pwr
              from telemetry where meter_id = ${meterId}
              order by ts asc limit ${limit}`,
    )
    .then((r) => (r as unknown as [Array<Record<string, unknown>>])[0]);
  return rows.map((r) => ({
    ts: new Date(String(r.ts)),
    socPercent: r.soc === null || r.soc === undefined ? null : Number(r.soc),
    batteryPowerKw: r.pwr === null || r.pwr === undefined ? null : Number(r.pwr),
  }));
}

/** Advance one battery's health figures. */
export async function trackBattery(row: HealthRow): Promise<void> {
  const db = getDb();
  const samples = await loadSamples(row.meterId, row.lastTs, PAGE);
  if (samples.length === 0) return;

  let prev: SocSample | null =
    row.lastTs && row.lastSocPct !== null
      ? { ts: row.lastTs, socPercent: row.lastSocPct, batteryPowerKw: row.lastPowerKw }
      : null;
  let window: WindowState | null =
    row.windowSocStart !== null ? { socStart: row.windowSocStart, dischargedKwh: row.windowKwh ?? 0 } : null;
  let windowStartedAt: Date | null = row.windowSocStart !== null ? (row.lastTs ?? samples[0].ts) : null;

  let efc = row.efc;
  let discharged = row.throughputDischargedKwh;
  let charged = row.throughputChargedKwh;
  let soh = row.sohPct;
  let sohSamples = row.sohSamples;
  let lastEstimateAt: Date | null = null;

  for (const s of samples) {
    if (prev && prev.socPercent !== null && s.socPercent !== null) {
      efc += efcDelta(prev.socPercent, s.socPercent);
    }
    if (prev) {
      const t = throughputDelta(prev, s);
      discharged += t.dischargedKwh;
      charged += t.chargedKwh;
    }

    const step = windowStep(window, prev, s);
    if (step.kind === "open") {
      window = step.next;
      windowStartedAt = s.ts;
    } else if (step.kind === "accumulate") {
      window = step.next;
    } else if (step.kind === "close") {
      const measured = capacityFromWindow(step.window);
      if (measured !== null && row.nameplateKwh !== null) {
        const pct = sohPercent(measured, row.nameplateKwh);
        if (pct !== null) {
          soh = blendSoh(soh, pct);
          sohSamples += 1;
          lastEstimateAt = s.ts;
          // The working is kept, not just the conclusion: a warranty claim is
          // an argument, and a single blended percentage is not something an
          // operator can put in front of a supplier.
          await db.insert(batteryCapacityEstimates).values({
            meterId: row.meterId,
            startedAt: windowStartedAt ?? s.ts,
            endedAt: s.ts,
            socStart: step.window.socStart,
            socEnd: step.window.socEnd,
            dischargedKwh: step.window.dischargedKwh,
            estimatedKwh: measured,
            sohPct: pct,
            orgId: row.orgId,
          });
        }
      }
      window = null;
      windowStartedAt = null;
    } else {
      window = step.next;
    }
    prev = s;
  }

  const last = samples[samples.length - 1];
  await db
    .update(batteryHealth)
    .set({
      efc,
      throughputDischargedKwh: discharged,
      throughputChargedKwh: charged,
      sohPct: soh,
      sohSamples,
      ...(lastEstimateAt ? { lastEstimateAt } : {}),
      lastTs: last.ts,
      lastSocPct: last.socPercent,
      lastPowerKw: last.batteryPowerKw,
      windowSocStart: window?.socStart ?? null,
      windowKwh: window?.dischargedKwh ?? null,
    })
    .where(eq(batteryHealth.meterId, row.meterId));
}

/** Create a health row for every BESS that does not have one yet. */
async function ensureRows(): Promise<void> {
  const db = getDb();
  const bess = await db
    .select({ id: meters.id, orgId: meters.orgId })
    .from(meters)
    .where(eq(meters.deviceType, "bess"));
  if (bess.length === 0) return;
  const existing = await db
    .select({ meterId: batteryHealth.meterId })
    .from(batteryHealth)
    .where(
      inArray(
        batteryHealth.meterId,
        bess.map((b) => b.id),
      ),
    );
  const have = new Set(existing.map((e) => e.meterId));
  const missing = bess.filter((b) => !have.has(b.id));
  if (missing.length === 0) return;
  await db
    .insert(batteryHealth)
    .values(missing.map((b) => ({ meterId: b.id, orgId: b.orgId })))
    // A concurrent sweep may have created it first; taking its row is fine.
    .onDuplicateKeyUpdate({ set: { orgId: sql`org_id` } });
}

export async function sohSweep(): Promise<{ tracked: number }> {
  await ensureRows();
  const db = getDb();
  const rows = await db.select().from(batteryHealth).limit(200);
  let tracked = 0;
  for (const r of rows) {
    try {
      await trackBattery({
        meterId: r.meterId,
        nameplateKwh: r.nameplateKwh,
        efc: r.efc,
        throughputDischargedKwh: r.throughputDischargedKwh,
        throughputChargedKwh: r.throughputChargedKwh,
        sohPct: r.sohPct,
        sohSamples: r.sohSamples,
        lastTs: r.lastTs,
        lastSocPct: r.lastSocPct,
        lastPowerKw: r.lastPowerKw,
        windowSocStart: r.windowSocStart,
        windowKwh: r.windowKwh,
        orgId: r.orgId,
      });
      tracked++;
    } catch (e) {
      console.warn(`[soh] meter ${r.meterId}:`, e instanceof Error ? e.message : e);
    }
  }
  return { tracked };
}

let timer: NodeJS.Timeout | null = null;
export function startSohLoop(): void {
  if (timer) return;
  timer = setInterval(() => {
    // Leased: two replicas walking the same cursor would both advance it and
    // each would book part of the throughput, so the fleet would quietly
    // under-count how hard its batteries had been worked.
    withLease("battery-soh", () => sohSweep()).catch((e) =>
      console.warn("[soh] sweep failed:", e instanceof Error ? e.message : e),
    );
  }, SWEEP_MS);
  timer.unref?.();
  console.log("[soh] battery health tracker started");
}
