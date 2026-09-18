import { useEffect, useState } from "react";

/** Current time as state, re-read on an interval.
 *
 *  Reading the clock during render is impure — React may render at any moment,
 *  so an "in progress" badge would change on unrelated re-renders and not
 *  change at all while the page sits open. A window that starts in two minutes
 *  should start looking active two minutes later without a refresh. */
export function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
