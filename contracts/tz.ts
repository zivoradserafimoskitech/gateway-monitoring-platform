// Timezone helpers shared by both sides of the boundary.
//
// They live in contracts/ for the same reason COVERAGE_OK does: the server
// decides who is on duty when an alarm fires, and the browser draws the "on
// duty now" badge next to each shift. Two implementations of "what time is it
// there" is how a rota that reads correct on screen pages the wrong person at
// 03:00.
//
// IANA offsets come from Intl, which is DST-correct per day and does not rely
// on the database shipping timezone tables (TiDB does not).

/** Offset (local − UTC) in ms at a given UTC instant. */
export function tzOffsetMs(tz: string, atUtc: Date): number {
  if (tz === "UTC") return 0;
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(atUtc)) parts[p.type] = p.value;
  const hour = Number(parts.hour) % 24;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    hour,
    Number(parts.minute),
    Number(parts.second),
  );
  // round to whole minutes — some zones have historical sub-minute offsets
  return Math.round((asUtc - atUtc.getTime()) / 60_000) * 60_000;
}

/** Local weekday (0=Sunday) and minutes-from-midnight for an instant in a zone. */
export function localClock(tz: string, now: Date): { dow: number; min: number } {
  const local = new Date(now.getTime() + tzOffsetMs(tz, now));
  return { dow: local.getUTCDay(), min: local.getUTCHours() * 60 + local.getUTCMinutes() };
}
