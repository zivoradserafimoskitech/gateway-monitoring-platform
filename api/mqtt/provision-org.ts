// §1.4: which tenant does a device that just announced itself belong to?
//
// The ingestion path is a shared MQTT subscription, so the broker's
// authenticated publisher identity is not visible to us — that is why the
// review called the full fix a broker-configuration change. These are the
// three answers that do NOT need the broker, in precedence order:
//
//   1. A pre-registration for the UID. Serial numbers are known before the
//      hardware ships, so an admin can say in advance which org a gateway
//      belongs to. This is the answer for a planned multi-tenant rollout.
//   2. MQTT_DEFAULT_ORG_ID. On a single-tenant installation every device
//      belongs to the one organization, and leaving them all NULL made the
//      whole fleet invisible to the only tenant there is.
//   3. Nothing — the device lands unclaimed, and a superadmin ends the limbo
//      from the queue (orgs.unclaimedDevices).
//
// Kept as a pure function so the precedence is testable without a broker, a
// database or a clock.
export interface ProvisionRegistration {
  orgId: number;
  siteId?: number | null;
}

export interface ProvisionTarget {
  orgId: number | null;
  siteId: number | null;
  /** Which rule decided, for the provisioning log line. */
  source: "registration" | "default-org" | "unclaimed";
}

/** Parse MQTT_DEFAULT_ORG_ID; anything that is not a positive integer is ignored. */
export function parseDefaultOrgId(raw: string | undefined): number | null {
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export function resolveProvisionTarget(
  registration: ProvisionRegistration | null,
  defaultOrgId: number | null,
): ProvisionTarget {
  if (registration) {
    return { orgId: registration.orgId, siteId: registration.siteId ?? null, source: "registration" };
  }
  if (defaultOrgId !== null) return { orgId: defaultOrgId, siteId: null, source: "default-org" };
  return { orgId: null, siteId: null, source: "unclaimed" };
}
