// §9.9: the part of a staged rollout that talks to the database.
//
// The decisions — which wave is next, when to halt — are pure and live in
// ./rollout.ts. This file only reads target rows, asks that module what to do,
// and does it.
import { and, eq, inArray } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { firmwareReleases, otaJobs, otaRolloutTargets, otaRollouts } from "@db/schema";
import { createOtaJob } from "./manager";
import { nextAction, type RolloutTarget } from "./rollout";

async function loadTargets(rolloutId: number): Promise<RolloutTarget[]> {
  const rows = await getDb()
    .select({
      gatewayId: otaRolloutTargets.gatewayId,
      batchIndex: otaRolloutTargets.batchIndex,
      status: otaRolloutTargets.status,
    })
    .from(otaRolloutTargets)
    .where(eq(otaRolloutTargets.rolloutId, rolloutId));
  return rows.map((r) => ({ gatewayId: r.gatewayId, batchIndex: r.batchIndex, status: r.status }));
}

/**
 * Mirror job outcomes onto the rollout's targets.
 *
 * The rollout does not re-implement delivery: each target carries the id of an
 * ordinary OTA job, and the existing manager does the publishing, the ack
 * timeouts and the retries. Reading the job's status back is what keeps the
 * rollout's view and the fleet's actual state the same thing.
 */
async function syncTargetStatuses(rolloutId: number): Promise<void> {
  const db = getDb();
  const live = await db
    .select({ id: otaRolloutTargets.id, jobId: otaRolloutTargets.jobId })
    .from(otaRolloutTargets)
    .where(and(eq(otaRolloutTargets.rolloutId, rolloutId), eq(otaRolloutTargets.status, "sent")));
  const jobIds = live.map((t) => t.jobId).filter((id): id is number => id !== null);
  if (jobIds.length === 0) return;
  const jobs = await db
    .select({ id: otaJobs.id, status: otaJobs.status, error: otaJobs.error })
    .from(otaJobs)
    .where(inArray(otaJobs.id, jobIds));
  const byId = new Map(jobs.map((j) => [j.id, j]));
  for (const t of live) {
    const job = t.jobId === null ? undefined : byId.get(t.jobId);
    if (!job) continue;
    if (job.status === "ack") {
      await db.update(otaRolloutTargets).set({ status: "ack" }).where(eq(otaRolloutTargets.id, t.id));
    } else if (job.status === "failed") {
      await db
        .update(otaRolloutTargets)
        .set({ status: "failed", error: (job.error ?? "job failed").slice(0, 500) })
        .where(eq(otaRolloutTargets.id, t.id));
    }
  }
}

/** Advance one rollout by at most one wave. */
export async function stepRollout(rolloutId: number): Promise<void> {
  const db = getDb();
  const rows = await db.select().from(otaRollouts).where(eq(otaRollouts.id, rolloutId)).limit(1);
  const rollout = rows[0];
  if (!rollout || rollout.status !== "running") return;

  await syncTargetStatuses(rolloutId);
  const targets = await loadTargets(rolloutId);
  const action = nextAction(targets, { failureThresholdPct: rollout.failureThresholdPct });

  if (action.kind === "wait") return;

  if (action.kind === "halt") {
    // Halted, not rolled back, and everything still pending stays pending
    // rather than being marked failed: those gateways were never touched, and
    // saying otherwise would misreport the size of the problem.
    await db
      .update(otaRollouts)
      .set({ status: "halted", haltReason: action.reason, finishedAt: new Date() })
      .where(eq(otaRollouts.id, rolloutId));
    console.warn(`[ota-rollout] ${rolloutId} halted: ${action.reason}`);
    return;
  }

  if (action.kind === "done") {
    await db
      .update(otaRollouts)
      .set({ status: "completed", finishedAt: new Date() })
      .where(eq(otaRollouts.id, rolloutId));
    console.log(`[ota-rollout] ${rolloutId} completed`);
    return;
  }

  const rel = await db
    .select()
    .from(firmwareReleases)
    .where(eq(firmwareReleases.id, rollout.releaseId))
    .limit(1);
  const release = rel[0];
  if (!release) {
    await db
      .update(otaRollouts)
      .set({ status: "halted", haltReason: "firmware release no longer exists", finishedAt: new Date() })
      .where(eq(otaRollouts.id, rolloutId));
    return;
  }

  for (const gatewayId of action.gatewayIds) {
    try {
      const job = await createOtaJob({
        gatewayId,
        type: "firmware",
        payload: { version: release.version, url: release.url, sha256: release.sha256 ?? undefined },
        createdBy: rollout.createdBy,
      });
      await db
        .update(otaRolloutTargets)
        .set({ status: "sent", jobId: job.id })
        .where(and(eq(otaRolloutTargets.rolloutId, rolloutId), eq(otaRolloutTargets.gatewayId, gatewayId)));
    } catch (e) {
      // A target that could not even be given a job is a failure of this wave,
      // and counts towards the threshold like any other: a gateway we cannot
      // reach is exactly the kind of thing that should stop a fleet update.
      await db
        .update(otaRolloutTargets)
        .set({ status: "failed", error: (e instanceof Error ? e.message : String(e)).slice(0, 500) })
        .where(and(eq(otaRolloutTargets.rolloutId, rolloutId), eq(otaRolloutTargets.gatewayId, gatewayId)));
    }
  }
  console.log(`[ota-rollout] ${rolloutId} dispatched batch ${action.batchIndex} (${action.gatewayIds.length} gateways)`);
}

/** Advance every running rollout. Called from the OTA sweep, under its lease. */
export async function rolloutSweep(): Promise<void> {
  const db = getDb();
  const running = await db
    .select({ id: otaRollouts.id })
    .from(otaRollouts)
    .where(eq(otaRollouts.status, "running"))
    .limit(20);
  for (const r of running) {
    try {
      await stepRollout(r.id);
    } catch (e) {
      console.error(`[ota-rollout] ${r.id} step failed:`, e instanceof Error ? e.message : e);
    }
  }
}
