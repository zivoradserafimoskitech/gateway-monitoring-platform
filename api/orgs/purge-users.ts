// §9.14 × §9.11: what deleting an org does to the accounts in it.
//
// Pure, so the rule can be tested without a database. The purge used to
// delete every user whose home org was the one going away, which predates
// memberships: since §9.11 an account can belong to several orgs, and its home
// org is only the one it is ACTIVE in. Deleting by home org removed an
// account another tenant still had as a member, and a platform administrator
// whose home org happened to be this one.

export interface PurgeUser<R extends string = string> {
  id: number;
  orgId: number | null;
  role: R;
  isSuperadmin: boolean;
}

export interface PurgeMembership<R extends string = string> {
  userId: number;
  orgId: number;
  role: R;
}

export interface UserDisposition<R extends string = string> {
  /** Accounts that belong nowhere once this org is gone: removed with it. */
  remove: number[];
  /** Accounts active in this org that are members of another: their active
   *  org moves to one that survives, with the role they hold there. */
  move: Array<{ userId: number; orgId: number; role: R }>;
  /** Platform administrators whose home org this was and who are members of
   *  nothing else: kept, with no home org. */
  detach: number[];
}

/**
 * Decide, per account, what deleting `orgId` means for it.
 *
 * `users` is every account whose home org is `orgId` or that holds a
 * membership in it; `memberships` is every membership those accounts hold, in
 * any org. Where an account could move to more than one org, the lowest org id
 * is taken, so the outcome does not depend on the order rows came back in.
 */
export function planUserRemoval<R extends string>(
  orgId: number,
  users: PurgeUser<R>[],
  memberships: PurgeMembership<R>[],
): UserDisposition<R> {
  const out: UserDisposition<R> = { remove: [], move: [], detach: [] };
  for (const u of users) {
    const elsewhere = memberships
      .filter((m) => m.userId === u.id && m.orgId !== orgId)
      .sort((a, b) => a.orgId - b.orgId);
    const activeHere = u.orgId === orgId;
    // A home org other than this one counts as belonging somewhere even
    // without a membership row for it — that is what every account looked
    // like before §9.11.
    const belongsElsewhere = elsewhere.length > 0 || (u.orgId !== null && !activeHere);

    if (u.isSuperadmin) {
      // Never removed: a platform administrator is not a tenant's account.
      if (activeHere) {
        if (elsewhere.length > 0) out.move.push({ userId: u.id, orgId: elsewhere[0].orgId, role: elsewhere[0].role });
        else out.detach.push(u.id);
      }
      continue;
    }
    if (!belongsElsewhere) {
      out.remove.push(u.id);
      continue;
    }
    if (activeHere) out.move.push({ userId: u.id, orgId: elsewhere[0].orgId, role: elsewhere[0].role });
    // Otherwise the account is active somewhere else already, and losing the
    // membership row here is all that changes for it.
  }
  return out;
}
