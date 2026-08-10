// v7/C8: timezone helpers — IANA offsets via Intl (DST-correct per day),
// without relying on DB tz tables (TiDB doesn't ship them).

// Offset (local − UTC) in ms at a given UTC instant.
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

export interface LocalDayRange {
  label: string; // YYYY-MM-DD in the site's zone
  startUtc: Date;
  endUtc: Date;
}

// All local days intersecting [fromUtc, toUtc], each mapped to its exact UTC
// bounds (offset sampled at local noon — DST transitions are thus exact).
export function localDayRanges(tz: string, fromUtc: Date, toUtc: Date): LocalDayRange[] {
  // Find the local calendar day containing fromUtc: use the offset to render
  // the instant in the zone, take its YYYY-MM-DD.
  const dayOf = (utc: Date): string => {
    const off = tzOffsetMs(tz, utc);
    return new Date(utc.getTime() + off).toISOString().slice(0, 10);
  };
  const firstDay = dayOf(fromUtc);
  const lastDay = dayOf(toUtc);
  const ranges: LocalDayRange[] = [];
  // Iterate local days from firstDay until lastDay (inclusive).
  let cursor = new Date(`${firstDay}T00:00:00Z`); // label date, treated as UTC anchor
  const end = new Date(`${lastDay}T00:00:00Z`);
  // Offset AT the local-midnight boundary — two refinement iterations (the
  // offset depends on the instant, which depends on the offset; real zones
  // converge after the second pass, incl. 1–3 am DST transitions).
  const midnightUtc = (labelUtcMs: number): Date => {
    let guess = new Date(labelUtcMs);
    for (let i = 0; i < 2; i++) {
      guess = new Date(labelUtcMs - tzOffsetMs(tz, guess));
    }
    return guess;
  };
  while (cursor.getTime() <= end.getTime()) {
    const label = cursor.toISOString().slice(0, 10);
    const startUtc = midnightUtc(cursor.getTime());
    const endUtc = midnightUtc(cursor.getTime() + 86_400_000);
    ranges.push({ label, startUtc, endUtc });
    cursor = new Date(cursor.getTime() + 86_400_000);
  }
  return ranges;
}
