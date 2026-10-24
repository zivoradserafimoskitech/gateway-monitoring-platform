// Fine-grained, per-site permissions.
//
// The org role (admin/operator/viewer) stays the coarse gate. A user may also
// hold per-SITE roles (site_roles table), e.g. a field technician who may
// commission and acknowledge alarms at two sites but control nothing, or a
// customer's site manager who may only view their own site. A site role can
// only ADD permissions on that site for a user who could not otherwise act —
// and, when a user has ANY site role in an org, it RESTRICTS them to those
// sites for that permission (see can()).
export const PERMISSIONS = [
  "site.view",
  "device.control",
  "alarm.ack",
  "alarm.configure",
  "commissioning.perform",
  "commissioning.signoff",
  "ota.deploy",
  "diagnostics.run",
  "config.write",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const SITE_ROLES = ["site_admin", "site_operator", "field_tech", "site_viewer"] as const;
export type SiteRole = (typeof SITE_ROLES)[number];

export const SITE_ROLE_PERMISSIONS: Record<SiteRole, readonly Permission[]> = {
  site_admin: PERMISSIONS,
  site_operator: ["site.view", "device.control", "alarm.ack", "alarm.configure", "diagnostics.run"],
  field_tech: ["site.view", "alarm.ack", "commissioning.perform", "diagnostics.run"],
  site_viewer: ["site.view"],
};

export const ORG_ROLE_PERMISSIONS: Record<"admin" | "operator" | "viewer", readonly Permission[]> = {
  admin: PERMISSIONS,
  operator: ["site.view", "device.control", "alarm.ack", "alarm.configure", "commissioning.perform", "diagnostics.run", "ota.deploy"],
  viewer: ["site.view"],
};

export interface SiteGrant {
  siteId: number;
  role: SiteRole;
  /** Extra permissions on top of the role (optional). */
  extra?: Permission[] | null;
}

export function siteGrantAllows(g: SiteGrant, perm: Permission): boolean {
  return SITE_ROLE_PERMISSIONS[g.role].includes(perm) || (g.extra ?? []).includes(perm);
}

/**
 * Decide one permission on one site.
 * - superadmin: always.
 * - user has site grants (scoped user): ONLY those grants count — a field
 *   tech with an org-level "operator" role is still confined to their sites.
 * - otherwise: the org role decides.
 */
export function can(
  user: { role: "admin" | "operator" | "viewer"; isSuperadmin?: boolean | number | null },
  siteId: number | null,
  perm: Permission,
  grants: SiteGrant[],
): boolean {
  if (user.isSuperadmin === true || user.isSuperadmin === 1) return true;
  if (grants.length > 0) {
    if (siteId === null) return false;
    return grants.some((g) => g.siteId === siteId && siteGrantAllows(g, perm));
  }
  return ORG_ROLE_PERMISSIONS[user.role].includes(perm);
}

export function validateExtra(extra: unknown): Permission[] | string {
  if (extra == null) return [];
  if (!Array.isArray(extra)) return "extra must be an array";
  for (const p of extra) if (!(PERMISSIONS as readonly string[]).includes(p)) return `unknown permission '${String(p)}'`;
  return extra as Permission[];
}
