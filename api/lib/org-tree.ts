// Installer / O&M organisation hierarchy.
//
// orgs.parent_org_id makes a tree: an installer or O&M company (parent) looks
// after several customer orgs (children). A user whose home org is a parent
// sees and operates the whole subtree; a customer user still sees only their
// own org. Org lifecycle (retention, deletion, claiming) stays superadmin-only.
//
// org-scope.ts helpers are synchronous and used on every request, so the tree
// lives in an in-memory snapshot refreshed every 60 s and on every hierarchy
// change (setParent). A stale snapshot can only lag a NEW grant by ≤60 s on
// other replicas; revoking a parent is applied locally at once and within
// 60 s elsewhere — documented in docs/org-hierarchy.md.
import { getDb } from "../queries/connection";
import { orgs } from "@db/schema";

export interface OrgNode {
  id: number;
  parentOrgId: number | null;
}

export const MAX_DEPTH = 4;

let children = new Map<number, number[]>();
let parents = new Map<number, number | null>();

export function setTree(rows: OrgNode[]): void {
  const c = new Map<number, number[]>();
  const p = new Map<number, number | null>();
  for (const r of rows) {
    p.set(r.id, r.parentOrgId);
    if (r.parentOrgId !== null) c.set(r.parentOrgId, [...(c.get(r.parentOrgId) ?? []), r.id]);
  }
  children = c;
  parents = p;
}

/** The org itself plus every descendant (cycle-safe, depth-bounded). */
export function subtree(orgId: number): number[] {
  const out = [orgId];
  const seen = new Set(out);
  let frontier = [orgId];
  for (let depth = 0; depth < MAX_DEPTH && frontier.length; depth++) {
    const next: number[] = [];
    for (const id of frontier) {
      for (const k of children.get(id) ?? []) {
        if (seen.has(k)) continue;
        seen.add(k);
        next.push(k);
      }
    }
    out.push(...next);
    frontier = next;
  }
  return out;
}

export function hasChildren(orgId: number): boolean {
  return (children.get(orgId)?.length ?? 0) > 0;
}

/**
 * Can `parentId` become the parent of `orgId`? Refuses self-parenting,
 * cycles, and trees deeper than MAX_DEPTH. Returns an error message or null.
 */
export function validateParent(orgId: number, parentId: number | null): string | null {
  if (parentId === null) return null;
  if (parentId === orgId) return "an organization cannot be its own parent";
  if (!parents.has(parentId)) return "parent organization not found";
  // Walk up from the proposed parent: meeting orgId means a cycle.
  let cur: number | null | undefined = parentId;
  let depth = 1;
  while (cur !== null && cur !== undefined) {
    if (cur === orgId) return "that would create a cycle in the organization tree";
    cur = parents.get(cur);
    depth++;
  }
  // Depth of the subtree hanging below orgId.
  const below = (id: number): number => Math.max(0, ...(children.get(id) ?? []).map((k) => 1 + below(k)));
  if (depth + below(orgId) > MAX_DEPTH) return `organization tree may be at most ${MAX_DEPTH} levels deep`;
  return null;
}

export async function refreshOrgTree(): Promise<void> {
  try {
    const rows = await getDb().select({ id: orgs.id, parentOrgId: orgs.parentOrgId }).from(orgs);
    setTree(rows);
  } catch (e) {
    console.warn("[org-tree] refresh failed:", e instanceof Error ? e.message : e);
  }
}

let timer: NodeJS.Timeout | null = null;
export function startOrgTreeLoop(): void {
  if (timer) return;
  void refreshOrgTree();
  timer = setInterval(() => void refreshOrgTree(), 60_000);
  timer.unref?.();
}
