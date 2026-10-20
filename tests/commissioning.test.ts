// §9.10: the commissioning checklist. The rules are the whole feature — a
// checklist that passes a site which is not actually commissioned is worse
// than no checklist, because somebody drives away trusting it.
import { describe, it, expect } from "vitest";
import {
  COMMISSIONING_STEPS,
  MANUAL_STEP,
  checklistSummary,
  evaluateChecklist,
  type SiteFacts,
} from "../contracts/commissioning";

function facts(over: Partial<SiteFacts> = {}): SiteFacts {
  return {
    siteName: "Test site",
    hasTimezone: true,
    gatewayCount: 1,
    gatewaysOnline: 1,
    deviceCount: 3,
    devicesReporting: 3,
    devicesWithDraftProfile: 0,
    devicesWithoutProfile: 0,
    enabledRulesCovering: 2,
    enabledChannels: 1,
    bessCount: 1,
    bessWithNameplate: 1,
    provenControlWrites: 4,
    handoverSignedBy: "A. Installer",
    handoverNote: null,
    ...over,
  };
}

const statusOf = (f: SiteFacts, step: string) => evaluateChecklist(f).find((r) => r.step === step)?.status;

describe("evaluateChecklist", () => {
  it("covers every declared step, in declared order", () => {
    // A step in the vocabulary with no evaluation would silently never appear
    // on the screen, and a site would look complete without it.
    expect(evaluateChecklist(facts()).map((r) => r.step)).toEqual([...COMMISSIONING_STEPS]);
  });

  it("passes a fully commissioned site", () => {
    const s = checklistSummary(evaluateChecklist(facts()));
    expect(s.complete).toBe(true);
    expect(s.blocking).toEqual([]);
    expect(s.passed).toBe(s.applicable);
  });

  it("fails a site with no timezone", () => {
    // Daily reports and EMS schedules both need one.
    expect(statusOf(facts({ hasTimezone: false }), "site.configured")).toBe("fail");
  });

  it("requires a gateway to be online NOW, not to have been seen once", () => {
    // A gateway that worked during the install and has been dark since is the
    // exact failure commissioning exists to catch before anyone leaves.
    expect(statusOf(facts({ gatewaysOnline: 0 }), "gateway.online")).toBe("fail");
  });

  it("requires EVERY device to be reporting, not just one", () => {
    expect(statusOf(facts({ devicesReporting: 2, deviceCount: 3 }), "telemetry.flowing")).toBe("fail");
    expect(statusOf(facts({ devicesReporting: 3, deviceCount: 3 }), "telemetry.flowing")).toBe("pass");
  });

  it("fails a site built on draft or missing profiles", () => {
    // A draft register map has never been checked against hardware: its
    // readings may be scaled wrongly and control through it is blocked, so the
    // site is not commissioned however healthy it looks.
    expect(statusOf(facts({ devicesWithDraftProfile: 1 }), "profiles.verified")).toBe("fail");
    expect(statusOf(facts({ devicesWithoutProfile: 1 }), "profiles.verified")).toBe("fail");
  });

  it("fails when alarms have nowhere to go", () => {
    expect(statusOf(facts({ enabledChannels: 0 }), "notifications.configured")).toBe("fail");
  });

  it("counts a fleet-wide rule as covering the site", () => {
    // The fact-gatherer reports null-meter rules in this count; the checklist
    // must not demand a site-specific rule on top of one that covers
    // everything.
    expect(statusOf(facts({ enabledRulesCovering: 1 }), "alarms.configured")).toBe("pass");
    expect(statusOf(facts({ enabledRulesCovering: 0 }), "alarms.configured")).toBe("fail");
  });

  it("requires evidence of control, not a rehearsal", () => {
    // A dry run deliberately writes no audit row, so it cannot satisfy this.
    expect(statusOf(facts({ provenControlWrites: 0 }), "control.proven")).toBe("fail");
  });

  it("marks battery steps n/a at a site with no battery — not passed", () => {
    // Reporting it as passed would make a site that has demonstrated nothing
    // about battery configuration look finished.
    const f = facts({ bessCount: 0, bessWithNameplate: 0 });
    expect(statusOf(f, "battery.nameplate")).toBe("n/a");
    const s = checklistSummary(evaluateChecklist(f));
    expect(s.applicable).toBe(COMMISSIONING_STEPS.length - 1);
    expect(s.complete).toBe(true);
  });

  it("fails a battery with no nameplate", () => {
    expect(statusOf(facts({ bessCount: 2, bessWithNameplate: 1 }), "battery.nameplate")).toBe("fail");
  });

  it("marks device-dependent steps n/a on an empty site, and still blocks on the rest", () => {
    const f = facts({ deviceCount: 0, devicesReporting: 0, bessCount: 0, bessWithNameplate: 0 });
    expect(statusOf(f, "telemetry.flowing")).toBe("n/a");
    expect(statusOf(f, "profiles.verified")).toBe("n/a");
    expect(statusOf(f, "control.proven")).toBe("n/a");
    // devices.present itself still fails — the site is plainly not finished.
    expect(statusOf(f, "devices.present")).toBe("fail");
    expect(checklistSummary(evaluateChecklist(f)).complete).toBe(false);
  });

  it("marks gateway.online n/a when there is no gateway, and still fails registration", () => {
    const f = facts({ gatewayCount: 0, gatewaysOnline: 0 });
    expect(statusOf(f, "gateway.online")).toBe("n/a");
    expect(statusOf(f, "gateway.registered")).toBe("fail");
  });

  it("leaves the handover pending until somebody signs", () => {
    expect(statusOf(facts({ handoverSignedBy: null }), MANUAL_STEP)).toBe("pending");
    expect(statusOf(facts({ handoverSignedBy: "B. Engineer" }), MANUAL_STEP)).toBe("pass");
  });

  it("a signature does not make the derived steps pass", () => {
    // The signature records what somebody SAW. A gateway that dropped after
    // handover must still read as a failure.
    const f = facts({ gatewaysOnline: 0, handoverSignedBy: "A. Installer" });
    const s = checklistSummary(evaluateChecklist(f));
    expect(s.complete).toBe(false);
    expect(s.blocking).toContain("gateway.online");
  });

  it("names the signer in the detail, so the row answers who", () => {
    const row = evaluateChecklist(facts({ handoverSignedBy: "C. Smith", handoverNote: "witnessed by client" })).find(
      (r) => r.step === MANUAL_STEP,
    );
    expect(row?.detail).toContain("C. Smith");
    expect(row?.detail).toContain("witnessed by client");
  });
});

describe("checklistSummary", () => {
  it("counts progress over APPLICABLE steps only", () => {
    // Otherwise a site with no battery could never reach 11/11 and would look
    // permanently unfinished.
    const f = facts({ bessCount: 0, bessWithNameplate: 0 });
    const s = checklistSummary(evaluateChecklist(f));
    expect(s.passed).toBe(s.applicable);
    expect(s.applicable).toBeLessThan(COMMISSIONING_STEPS.length);
  });

  it("lists every blocker rather than only the first", () => {
    const s = checklistSummary(
      evaluateChecklist(facts({ hasTimezone: false, enabledChannels: 0, handoverSignedBy: null })),
    );
    expect(s.blocking).toEqual(["site.configured", "notifications.configured", MANUAL_STEP]);
  });
});
