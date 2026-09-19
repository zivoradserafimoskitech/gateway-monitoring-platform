// §9.8: who gets woken, and when nobody should be.
//
// Two decisions live here, both pure so they can be reasoned about without a
// database:
//
//   1. Suppression — "this rule/device/site is known-broken, stop paging while
//      we fix it". Narrower than a maintenance window, and it does NOT stop
//      the alarm being raised: the record of the condition is not the thing
//      anyone wanted silenced.
//   2. The on-call rota — which channels are actually on duty right now.
//
// Both are deliberately conservative. Suppression needs an explicit window and
// a reason; the rota is opt-in and, when unconfigured, changes nothing.
//
// In contracts/ rather than under api/ because both sides have to agree: the
// server decides who gets paged, and the settings screen shows which shift is
// live right now. A second implementation of "is this shift on duty" is how a
// rota that reads correct on screen wakes the wrong person.
import { localClock } from "./tz";

// ─── Suppression ─────────────────────────────────────────────────────────────
export type SuppressionScope = "rule" | "meter" | "site";

export interface SuppressionRow {
  id: number;
  scope: SuppressionScope;
  refId: number;
  startsAt: Date;
  endsAt: Date;
  reason: string;
}

/** What an alarm is attached to, for matching against suppression scopes. */
export interface AlarmSubject {
  ruleId: number | null;
  meterId: number | null;
  siteId: number | null;
}

function matchesSubject(row: SuppressionRow, subject: AlarmSubject): boolean {
  if (row.scope === "rule") return subject.ruleId != null && row.refId === subject.ruleId;
  if (row.scope === "meter") return subject.meterId != null && row.refId === subject.meterId;
  return subject.siteId != null && row.refId === subject.siteId;
}

/**
 * The suppression in force for this alarm, or null.
 *
 * Bounds are half-open at the end (`startsAt <= now < endsAt`) so a window that
 * ends at 09:00 and one that starts at 09:00 do not both claim 09:00 — with an
 * inclusive end, back-to-back windows overlap by an instant and the earlier
 * (already expired) reason is the one that gets recorded.
 *
 * When several apply, the NARROWEST wins: rule beats meter beats site. An
 * operator who suppressed one rule and, separately, a whole site wants the
 * reason on the record to be the specific one. Ties break on the later start —
 * the most recent decision about the same scope is the current one.
 */
export function activeSuppression(
  rows: SuppressionRow[],
  subject: AlarmSubject,
  now: Date,
): SuppressionRow | null {
  const t = now.getTime();
  const narrowness: Record<SuppressionScope, number> = { rule: 0, meter: 1, site: 2 };
  let best: SuppressionRow | null = null;
  for (const row of rows) {
    if (row.startsAt.getTime() > t || row.endsAt.getTime() <= t) continue;
    if (!matchesSubject(row, subject)) continue;
    if (
      best === null ||
      narrowness[row.scope] < narrowness[best.scope] ||
      (narrowness[row.scope] === narrowness[best.scope] &&
        row.startsAt.getTime() > best.startsAt.getTime())
    ) {
      best = row;
    }
  }
  return best;
}

// ─── On-call rota ────────────────────────────────────────────────────────────
export interface ShiftRow {
  channelId: number;
  dayOfWeekMask: number;
  startMin: number;
  endMin: number;
  timezone: string;
  enabled: boolean;
}

/**
 * Is a shift covering this instant? Same window semantics as ems_schedules:
 * bit 0 of the mask is Sunday, equal start and end means all day, and an end
 * before the start wraps past midnight (which is what a night shift is).
 *
 * The day is tested against the LOCAL weekday at the shift's own start, so a
 * Friday 22:00–06:00 shift is on duty at 02:00 on Saturday — the operator who
 * ticked "Friday" meant the night that begins on Friday, not two disjoint
 * pieces of Friday.
 */
export function shiftCovers(shift: ShiftRow, now: Date): boolean {
  if (!shift.enabled) return false;
  const { dow, min } = localClock(shift.timezone, now);
  const wraps = shift.endMin < shift.startMin;
  if (shift.startMin === shift.endMin) return ((shift.dayOfWeekMask >> dow) & 1) === 1;
  if (!wraps) {
    if (((shift.dayOfWeekMask >> dow) & 1) === 0) return false;
    return min >= shift.startMin && min < shift.endMin;
  }
  // Wrapping shift: the evening half belongs to today, the morning half to the
  // day that started yesterday.
  if (min >= shift.startMin) return ((shift.dayOfWeekMask >> dow) & 1) === 1;
  if (min < shift.endMin) return ((shift.dayOfWeekMask >> ((dow + 6) % 7)) & 1) === 1;
  return false;
}

/**
 * Channel ids on duty, or null when no rota is configured.
 *
 * `null` is the whole point of the design: an org with no shifts (or none
 * enabled) gets the pre-rota behaviour, every channel notified. A rota that
 * quietly pages nobody because somebody half-configured it is worse than no
 * rota at all, so it only ever takes effect once at least one shift exists.
 *
 * Note this can legitimately return an EMPTY set — shifts exist but none
 * covers right now. That is a real gap in the rota, and callers treat it as
 * such (see coverageGap) rather than silently falling back to everyone.
 */
export function onDutyChannelIds(shifts: ShiftRow[], now: Date): Set<number> | null {
  const live = shifts.filter((s) => s.enabled);
  if (live.length === 0) return null;
  const onDuty = new Set<number>();
  for (const s of live) {
    if (shiftCovers(s, now)) onDuty.add(s.channelId);
  }
  return onDuty;
}

/**
 * Apply the rota to a set of candidate channels.
 *
 * Fails OPEN on an uncovered hour: if the rota is configured but nobody is on
 * duty, every candidate is notified and `gap` is true. The alternative —
 * dropping the page — means a critical alarm at an hour the rota forgot about
 * reaches nobody at all, and nothing in the system would ever say so. A
 * duplicate page is recoverable; a missed one is not.
 */
export function applyRota<T extends { id: number }>(
  candidates: T[],
  onDuty: Set<number> | null,
): { channels: T[]; gap: boolean } {
  if (onDuty === null) return { channels: candidates, gap: false };
  const filtered = candidates.filter((c) => onDuty.has(c.id));
  if (filtered.length === 0 && candidates.length > 0) return { channels: candidates, gap: true };
  return { channels: filtered, gap: false };
}
