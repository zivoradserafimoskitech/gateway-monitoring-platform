// Fleet selection: resolve a target (explicit ids, group, tags) to gateway ids.
export const TAG_RE = /^[a-z0-9][a-z0-9_.:-]{0,47}$/;

export function normalizeTags(tags: readonly string[]): string[] {
  const out = new Set<string>();
  for (const t of tags) {
    const n = t.trim().toLowerCase();
    if (!TAG_RE.test(n)) throw new Error(`invalid tag '${t}'`);
    out.add(n);
  }
  if (out.size > 32) throw new Error("at most 32 tags per gateway");
  return [...out].sort();
}

export interface FleetGateway { id: number; tags: string[] | null }

/** Gateways matching ALL given tags (AND). */
export function matchTags(gws: readonly FleetGateway[], tags: readonly string[]): number[] {
  const want = normalizeTags(tags);
  return gws.filter((g) => want.every((t) => (g.tags ?? []).includes(t))).map((g) => g.id);
}

/** Intersect a requested selection with what the caller may see; dedupe; stable order. */
export function resolveSelection(
  visible: readonly FleetGateway[],
  sel: { gatewayIds?: number[]; groupMemberIds?: number[]; tags?: string[] },
): number[] {
  const allowed = new Set(visible.map((g) => g.id));
  let ids: number[] | null = null;
  const and = (next: number[]) => {
    ids = ids === null ? next : ids.filter((i) => next.includes(i));
  };
  if (sel.gatewayIds?.length) and(sel.gatewayIds);
  if (sel.groupMemberIds) and(sel.groupMemberIds);
  if (sel.tags?.length) and(matchTags(visible, sel.tags));
  const chosen: number[] = ids ?? visible.map((g) => g.id);
  return [...new Set(chosen)].filter((i) => allowed.has(i)).sort((a, b) => a - b);
}
