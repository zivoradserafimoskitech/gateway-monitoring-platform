// Plan ownership: which plan the EMS controller executes.
//
// Gateway Monitoring Platform = devices, physics, safety.
// VoltTrade = money and decisions (prices, forecast, optimisation, trading).
//
// Economic plans are therefore produced by VoltTrade and pushed in through
// PUT /api/v1/devices/:id/ems-plan. The gateway's own TOU optimiser
// (api/ems/optimizer.ts, source "tariff-optimizer") is a FALLBACK only: it
// plans when there is no valid, fresh external plan, e.g. when the link to
// VoltTrade is down. Safety layers (grid connection limit, SoC guard,
// emergency stop, peak clamp) always run on top of whichever plan wins.

/** Source string written by the local fallback optimiser. */
export const LOCAL_PLAN_SOURCE = "tariff-optimizer";

/** Minimal plan shape needed to arbitrate. */
export interface ArbitrablePlan {
  id: number;
  source: string;
  createdAt?: Date | string | null;
}

export function isExternalSource(source: string): boolean {
  return source !== LOCAL_PLAN_SOURCE;
}

/**
 * An external plan older than this (since it was pushed) is treated as stale:
 * the upstream optimiser has stopped refreshing it, so the local fallback may
 * take over. EMS_EXTERNAL_PLAN_MAX_AGE_MIN, default 1440 (24h). 0 disables the
 * age check (any active external plan covering now wins).
 */
export function externalPlanMaxAgeMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.EMS_EXTERNAL_PLAN_MAX_AGE_MIN ?? "1440");
  return Number.isFinite(raw) && raw >= 0 ? raw * 60_000 : 1440 * 60_000;
}

/**
 * Local optimiser mode. "fallback" (default): plan only when no fresh
 * external plan exists. "off": never plan locally.
 */
export function localOptimizerMode(env: NodeJS.ProcessEnv = process.env): "fallback" | "off" {
  return env.EMS_LOCAL_OPTIMIZER === "off" ? "off" : "fallback";
}

export function isFreshExternal(plan: ArbitrablePlan, nowMs: number, maxAgeMs: number): boolean {
  if (!isExternalSource(plan.source)) return false;
  if (maxAgeMs === 0 || plan.createdAt == null) return true;
  const created = new Date(plan.createdAt).getTime();
  return Number.isFinite(created) && nowMs - created <= maxAgeMs;
}

/**
 * Pick the plan to execute among the active plans covering now for ONE meter,
 * given newest-first. A fresh external plan always wins over the local
 * fallback, regardless of which was written last. With no fresh external plan
 * the newest local plan is used; a stale external plan is used only when there
 * is no local plan at all (better than nothing — it still passed validation).
 */
export function choosePlan<T extends ArbitrablePlan>(plansNewestFirst: T[], nowMs: number, maxAgeMs: number): T | null {
  const fresh = plansNewestFirst.find((p) => isFreshExternal(p, nowMs, maxAgeMs));
  if (fresh) return fresh;
  const local = plansNewestFirst.find((p) => !isExternalSource(p.source));
  return local ?? plansNewestFirst[0] ?? null;
}
