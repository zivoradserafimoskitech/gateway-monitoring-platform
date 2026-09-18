// §9.14: per-org telemetry retention, as a pure decision.
//
// Retention was one global number (TELEMETRY_RAW_DAYS). That cannot serve two
// tenants at once: one under a regulator requiring five years of interval data
// and one who wants nothing kept past a month are both reasonable, and a
// single figure has to be wrong for one of them.
//
// The subtlety is that raw telemetry is purged by a single sweep over a shared
// table, so the sweep has to respect the LONGEST retention anyone asked for —
// otherwise the global purge would delete, at ninety days, the very rows a
// tenant is paying to keep for five years. Shorter retentions are then applied
// as targeted follow-up deletes.

export interface OrgRetention {
  orgId: number;
  days: number;
}

export interface RetentionPlan {
  /** Everything older than this may go, whoever it belongs to. */
  globalCutoff: Date;
  /** Orgs that keep LESS than the longest retention: delete their rows past
   *  their own, later, cutoff. */
  perOrg: Array<{ orgId: number; cutoff: Date }>;
  /** The latest cutoff in the plan — everything about to be deleted must be
   *  rolled up to here first, or a tenant with a short retention would lose
   *  hours that never made it into an aggregate. */
  rollupUpTo: Date;
}

const DAY_MS = 86_400_000;

/**
 * Build the purge plan.
 *
 * `defaultDays` applies to every org without an override, AND to rows whose
 * device has no org at all (auto-provisioned hardware waiting in the unclaimed
 * queue) — those are the deployment's, so they follow the deployment's rule.
 *
 * Note which direction the arithmetic runs: more days means an EARLIER cutoff.
 * The global cutoff is therefore built from the LONGEST retention, and every
 * org keeping less appears in `perOrg` with a later one.
 */
export function retentionPlan(
  now: Date,
  defaultDays: number,
  overrides: OrgRetention[],
): RetentionPlan {
  const sane = (d: number): number => (Number.isFinite(d) && d >= 1 ? Math.floor(d) : defaultDays);
  const def = Math.max(1, Math.floor(defaultDays));
  const cleaned = overrides
    .map((o) => ({ orgId: o.orgId, days: sane(o.days) }))
    // An override equal to the default is not an override; keeping it would
    // add a targeted delete that can never match a row.
    .filter((o) => o.days !== def);
  const longest = Math.max(def, ...cleaned.map((o) => o.days));
  const globalCutoff = new Date(now.getTime() - longest * DAY_MS);

  const perOrg = cleaned
    .filter((o) => o.days < longest)
    .map((o) => ({ orgId: o.orgId, cutoff: new Date(now.getTime() - o.days * DAY_MS) }));
  // Orgs with no override keep the default; when somebody else's override is
  // longer, the default itself becomes a targeted delete rather than the
  // global one. Callers handle that case with a NULL-org-aware delete, so it
  // is represented here by the default cutoff being later than the global one.
  const defaultCutoff = new Date(now.getTime() - def * DAY_MS);

  const rollupUpTo = new Date(
    Math.max(globalCutoff.getTime(), defaultCutoff.getTime(), ...perOrg.map((p) => p.cutoff.getTime())),
  );
  return { globalCutoff, perOrg, rollupUpTo };
}

/**
 * Does the default retention need its own targeted delete?
 *
 * True when some org keeps data longer than the default: the global sweep then
 * runs at that longer horizon, and everyone on the default has to be purged
 * separately. When nobody keeps longer, the global sweep IS the default and
 * this is false — which is the single-tenant case, and it stays exactly as
 * cheap as it was before per-org retention existed.
 */
export function defaultNeedsOwnPass(plan: RetentionPlan, now: Date, defaultDays: number): boolean {
  const def = Math.max(1, Math.floor(defaultDays));
  const defaultCutoff = now.getTime() - def * DAY_MS;
  return defaultCutoff > plan.globalCutoff.getTime();
}
