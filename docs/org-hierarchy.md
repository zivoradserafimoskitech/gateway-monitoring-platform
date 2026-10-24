# Installer / O&M hierarchy and per-site roles

## Organisation tree

`orgs.parent_org_id` + `orgs.kind` (`direct`, `installer`, `om`, `customer`).
An installer or O&M company is a **parent**; its customers are **children**
(max 4 levels, no cycles — `api/lib/org-tree.ts`).

- A user whose home org has children sees and operates the **whole subtree**:
  every `orgWhere` / `assertOrg*` check in `api/lib/org-scope.ts` uses
  `accessibleOrgIds(user)`.
- A customer user still sees only their own org.
- Org lifecycle (retention, deletion, device claiming, `setParent`) remains
  superadmin-only.
- The tree is an in-memory snapshot refreshed every 60 s and immediately on
  `orgs.setParent`. On other replicas a change applies within 60 s.

tRPC: `orgs.tree` (caller's subtree), `orgs.setParent` (superadmin).

## Per-site roles

`site_roles(user_id, site_id, org_id, role, extra)` with roles:

| Role | Permissions |
|---|---|
| `site_admin` | all |
| `site_operator` | site.view, device.control, alarm.ack, alarm.configure, diagnostics.run |
| `field_tech` | site.view, alarm.ack, commissioning.perform, diagnostics.run |
| `site_viewer` | site.view |

`extra` adds individual permissions (`api/lib/permissions.ts`). **A user with
any site role is confined to those sites** for permission checks, whatever
their org role. Users without site roles behave exactly as before (org role).

Enforced today on `control.execute` (`device.control`) via
`requireSitePermission`; other procedures can adopt the same one-line check.
tRPC: `orgs.siteRoles`, `orgs.grantSiteRole`, `orgs.revokeSiteRole`,
`orgs.myPermissions`.

Migration: `0044_org_hierarchy_site_roles.sql` (additive; nothing changes until
a parent or a site role is set).
