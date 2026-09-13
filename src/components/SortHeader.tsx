// The clickable column header for useSortable. It lives beside the other
// components rather than in the hook file: a module that exports both a hook
// and a component breaks React Fast Refresh, which is what the lint rule
// react-refresh/only-export-components is there to catch.
import type { ReactNode } from "react";
import { TableHead } from "@/components/ui/table";
import { ChevronDown, ChevronUp, ChevronsUpDown } from "lucide-react";
import { cn } from "@/lib/utils";
import type { SortState } from "@/hooks/use-sortable";

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
