// §8: the long tables had no column sorting, so "which device has been offline
// longest" or "which gateway has the weakest signal" meant reading every row.
//
// Sorting is local and the tables are already bounded by the org-scoped
// queries that feed them, so this stays a client concern — no new endpoint and
// no change to what the server returns.
import { useCallback, useState, type ReactNode } from "react";
import { TableHead } from "@/components/ui/table";
import { ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";

export type SortDir = "asc" | "desc";
export interface SortState {
  key: string;
  dir: SortDir;
}

/** Comparable projection of a row for one column; null sorts last either way. */
export type SortValue = string | number | Date | null | undefined;

function compare(a: SortValue, b: SortValue): number {
  // Nulls last in BOTH directions: a device that has never reported is not
  // "the oldest", it is unknown, and burying it under the real answers is what
  // an operator scanning the top of the list wants.
  if (a === null || a === undefined) return b === null || b === undefined ? 0 : 1;
  if (b === null || b === undefined) return -1;
  if (a instanceof Date || b instanceof Date) return new Date(a).getTime() - new Date(b).getTime();
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

/**
 * Click-to-sort state for one table. Cycles ascending → descending → unsorted,
 * so a user can always get back to the server's own ordering, which for these
 * tables is "newest first" and is the right default for most questions.
 */
export function useSortable(initial: SortState | null = null) {
  const [sort, setSort] = useState<SortState | null>(initial);

  const toggle = useCallback((key: string) => {
    setSort((s) => (s?.key !== key ? { key, dir: "asc" } : s.dir === "asc" ? { key, dir: "desc" } : null));
  }, []);

  const sorted = useCallback(
    <T,>(rows: T[], accessors: Record<string, (row: T) => SortValue>): T[] => {
      if (!sort) return rows;
      const get = accessors[sort.key];
      if (!get) return rows;
      // Copy first: sorting the query cache's array in place would hand React
      // Query back the same (already reordered) reference, and the UI would
      // stop updating.
      const out = [...rows].sort((x, y) => compare(get(x), get(y)));
      return sort.dir === "asc" ? out : out.reverse();
    },
    [sort],
  );

  return { sort, toggle, sorted };
}

export function SortHeader({
  column,
  sort,
  onToggle,
  children,
  className,
}: {
  column: string;
  sort: SortState | null;
  onToggle: (key: string) => void;
  children: ReactNode;
  className?: string;
}) {
  const active = sort?.key === column;
  const Icon = !active ? ChevronsUpDown : sort.dir === "asc" ? ChevronUp : ChevronDown;
  return (
    <TableHead className={className}>
      <button
        type="button"
        onClick={() => onToggle(column)}
        aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
        className={cn(
          "-mx-1 inline-flex items-center gap-1 rounded px-1 py-0.5 hover:text-foreground",
          active ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {children}
        <Icon className="h-3 w-3 shrink-0 opacity-70" />
      </button>
    </TableHead>
  );
}
