// §9.10: the commissioning checklist.
//
// docs/commissioning.md describes the end-to-end procedure well, and that was
// the whole of it: a document. An installer on a roof had no way to see what
// had already been done on the previous visit, and nobody back at the office
// could tell which of thirty sites were half-finished. "Did anyone configure
// the alarms on that site?" was answered by opening four screens and guessing.
//
// The decision that makes this worth building rather than a form: every step
// that CAN be verified from the system's own data is verified, every tick, and
// cannot be ticked by hand. A checklist that only records opinions is a form;
// one that checks itself is a tool. The single step no database can attest —
// that a human walked the site and signed it off — is the only manual one, and
// it is deliberately last.
//
// In contracts/ because both sides need the same vocabulary: the server
// evaluates the steps and the browser draws them in order.

export const COMMISSIONING_STEPS = [
  "site.configured",
  "gateway.registered",
  "gateway.online",
  "devices.present",
  "telemetry.flowing",
  "profiles.verified",
  "alarms.configured",
  "notifications.configured",
  "battery.nameplate",
  "control.proven",
  "handover.signed",
] as const;

export type CommissioningStep = (typeof COMMISSIONING_STEPS)[number];

/** The one step a human signs. Everything else is derived. */
export const MANUAL_STEP: CommissioningStep = "handover.signed";

export type StepStatus =
  // Verified from the system's own data.
  | "pass"
  // Verifiable, and currently not satisfied.
  | "fail"
  // Does not apply to this site (no battery, for instance). Distinct from
  // "pass" on purpose: a site with no BESS has not demonstrated anything about
  // battery configuration, and reporting it as passed would be a small lie
  // that makes a 10/11 site look finished.
  | "n/a"
  // The manual step, not yet signed.
  | "pending";

export interface StepResult {
  step: CommissioningStep;
  status: StepStatus;
  /** What was checked and what was found — shown next to the step. */
  detail: string;
}

/** Facts gathered from the database; see api/commissioning/evaluate.ts. */
export interface SiteFacts {
  siteName: string;
  hasTimezone: boolean;
  gatewayCount: number;
  gatewaysOnline: number;
  deviceCount: number;
  /** Devices whose most recent sample is within the freshness window. */
  devicesReporting: number;
  /** Devices whose model has a profile still in draft verification. */
  devicesWithDraftProfile: number;
  /** Devices with no profile for their model at all. */
  devicesWithoutProfile: number;
  enabledRulesCovering: number;
  enabledChannels: number;
  bessCount: number;
  bessWithNameplate: number;
  /** Successful control writes to a device at this site. */
  provenControlWrites: number;
  /** Set once somebody signs the handover. */
  handoverSignedBy: string | null;
  handoverNote: string | null;
}

function result(step: CommissioningStep, ok: boolean, detail: string): StepResult {
  return { step, status: ok ? "pass" : "fail", detail };
}

/**
 * Evaluate the whole checklist.
 *
 * Ordered as an installer actually works: the site exists, then hardware is
 * registered, then it speaks, then what it says is trustworthy, then the
 * things that make it operable, and last the signature.
 */
export function evaluateChecklist(f: SiteFacts): StepResult[] {
  const steps: StepResult[] = [];

  steps.push(result("site.configured", f.hasTimezone, f.hasTimezone ? "Timezone set" : "No timezone — daily reports and schedules need one"));

  steps.push(
    result(
      "gateway.registered",
      f.gatewayCount > 0,
      f.gatewayCount > 0 ? `${f.gatewayCount} gateway(s) bound to this site` : "No gateway bound to this site",
    ),
  );

  // Deliberately NOT "has ever been seen": a gateway that was online during
  // the install and has been dark since is the exact failure commissioning is
  // supposed to catch before anyone leaves.
  steps.push(
    f.gatewayCount === 0
      ? { step: "gateway.online", status: "n/a", detail: "No gateway to check" }
      : result(
          "gateway.online",
          f.gatewaysOnline > 0,
          `${f.gatewaysOnline} of ${f.gatewayCount} gateway(s) online now`,
        ),
  );

  steps.push(
    result(
      "devices.present",
      f.deviceCount > 0,
      f.deviceCount > 0 ? `${f.deviceCount} device(s)` : "No devices under this site",
    ),
  );

  steps.push(
    f.deviceCount === 0
      ? { step: "telemetry.flowing", status: "n/a", detail: "No devices to check" }
      : result(
          "telemetry.flowing",
          f.devicesReporting === f.deviceCount,
          `${f.devicesReporting} of ${f.deviceCount} device(s) reporting`,
        ),
  );

  // A draft profile means the register map has never been checked against real
  // hardware. Readings from it may be scaled wrongly, and control through it
  // is blocked anyway — so a site built on draft profiles is not commissioned,
  // however healthy it looks.
  const profileProblems = f.devicesWithDraftProfile + f.devicesWithoutProfile;
  steps.push(
    f.deviceCount === 0
      ? { step: "profiles.verified", status: "n/a", detail: "No devices to check" }
      : result(
          "profiles.verified",
          profileProblems === 0,
          profileProblems === 0
            ? "Every device's register map is verified"
            : `${f.devicesWithDraftProfile} draft, ${f.devicesWithoutProfile} with no profile`,
        ),
  );

  steps.push(
    result(
      "alarms.configured",
      f.enabledRulesCovering > 0,
      f.enabledRulesCovering > 0
        ? `${f.enabledRulesCovering} enabled rule(s) cover this site`
        : "No enabled alarm rule covers this site's devices",
    ),
  );

  // A rule with nowhere to send its alarm is a rule nobody will see.
  steps.push(
    result(
      "notifications.configured",
      f.enabledChannels > 0,
      f.enabledChannels > 0
        ? `${f.enabledChannels} enabled channel(s)`
        : "No notification channel — alarms would only appear in the UI",
    ),
  );

  steps.push(
    f.bessCount === 0
      ? { step: "battery.nameplate", status: "n/a", detail: "No battery at this site" }
      : result(
          "battery.nameplate",
          f.bessWithNameplate === f.bessCount,
          `${f.bessWithNameplate} of ${f.bessCount} battery(ies) have a nameplate`,
        ),
  );

  // Evidence, not an opinion: a control write that was actually accepted by
  // the hardware. A dry run deliberately leaves no audit row, so it cannot
  // satisfy this — a rehearsal is not proof that the real thing works.
  steps.push(
    f.deviceCount === 0
      ? { step: "control.proven", status: "n/a", detail: "No devices to check" }
      : result(
          "control.proven",
          f.provenControlWrites > 0,
          f.provenControlWrites > 0
            ? `${f.provenControlWrites} successful control write(s) on record`
            : "No successful control write recorded for this site",
        ),
  );

  steps.push({
    step: MANUAL_STEP,
    status: f.handoverSignedBy ? "pass" : "pending",
    detail: f.handoverSignedBy
      ? `Signed by ${f.handoverSignedBy}${f.handoverNote ? ` — ${f.handoverNote}` : ""}`
      : "Not signed",
  });

  return steps;
}

/**
 * Is the site commissioned?
 *
 * Every applicable step must pass. "n/a" does not block — a site with no
 * battery cannot demonstrate a nameplate — but it is never counted as
 * progress either, which is why `applicable` excludes it.
 */
export function checklistSummary(results: StepResult[]): {
  passed: number;
  applicable: number;
  blocking: CommissioningStep[];
  complete: boolean;
} {
  const applicable = results.filter((r) => r.status !== "n/a");
  const passed = applicable.filter((r) => r.status === "pass").length;
  const blocking = applicable.filter((r) => r.status !== "pass").map((r) => r.step);
  return { passed, applicable: applicable.length, blocking, complete: blocking.length === 0 };
}
