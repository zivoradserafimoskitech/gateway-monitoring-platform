// §9.8: suppression windows and the on-call rota. Both are pure, so the cases
// that decide whether a person's phone rings at 03:00 can be driven exactly.
import { describe, it, expect } from "vitest";
import {
  activeSuppression,
  applyRota,
  onDutyChannelIds,
  shiftCovers,
  type ShiftRow,
  type SuppressionRow,
} from "../contracts/oncall";

const D = (iso: string) => new Date(iso);

function supp(over: Partial<SuppressionRow> = {}): SuppressionRow {
  return {
    id: 1,
    scope: "meter",
    refId: 7,
    startsAt: D("2026-03-10T08:00:00Z"),
    endsAt: D("2026-03-10T12:00:00Z"),
    reason: "inverter swap",
    ...over,
  };
}

const SUBJECT = { ruleId: 3, meterId: 7, siteId: 2 };

describe("activeSuppression", () => {
  it("matches inside the window", () => {
    const hit = activeSuppression([supp()], SUBJECT, D("2026-03-10T09:00:00Z"));
    expect(hit?.reason).toBe("inverter swap");
  });

  it("does not match before it starts or after it ends", () => {
    expect(activeSuppression([supp()], SUBJECT, D("2026-03-10T07:59:59Z"))).toBeNull();
    expect(activeSuppression([supp()], SUBJECT, D("2026-03-10T12:00:01Z"))).toBeNull();
  });

  it("is half-open at the end so back-to-back windows do not overlap", () => {
    const earlier = supp({ id: 1, reason: "first" });
    const later = supp({
      id: 2,
      reason: "second",
      startsAt: D("2026-03-10T12:00:00Z"),
      endsAt: D("2026-03-10T16:00:00Z"),
    });
    // Exactly on the boundary: the window that just ended must not claim it.
    const hit = activeSuppression([earlier, later], SUBJECT, D("2026-03-10T12:00:00Z"));
    expect(hit?.reason).toBe("second");
  });

  it("ignores a window for a different device", () => {
    expect(activeSuppression([supp({ refId: 99 })], SUBJECT, D("2026-03-10T09:00:00Z"))).toBeNull();
  });

  it("matches a rule-scoped and a site-scoped window", () => {
    expect(
      activeSuppression([supp({ scope: "rule", refId: 3 })], SUBJECT, D("2026-03-10T09:00:00Z")),
    ).not.toBeNull();
    expect(
      activeSuppression([supp({ scope: "site", refId: 2 })], SUBJECT, D("2026-03-10T09:00:00Z")),
    ).not.toBeNull();
  });

  it("prefers the narrowest scope when several apply", () => {
    const rows = [
      supp({ id: 1, scope: "site", refId: 2, reason: "site works" }),
      supp({ id: 2, scope: "meter", refId: 7, reason: "meter works" }),
      supp({ id: 3, scope: "rule", refId: 3, reason: "rule is noisy" }),
    ];
    expect(activeSuppression(rows, SUBJECT, D("2026-03-10T09:00:00Z"))?.reason).toBe("rule is noisy");
  });

  it("breaks a tie within one scope on the later start", () => {
    const rows = [
      supp({ id: 1, reason: "older", startsAt: D("2026-03-10T06:00:00Z") }),
      supp({ id: 2, reason: "newer", startsAt: D("2026-03-10T08:30:00Z") }),
    ];
    expect(activeSuppression(rows, SUBJECT, D("2026-03-10T09:00:00Z"))?.reason).toBe("newer");
  });

  it("never matches a subject with a null id against refId 0", () => {
    const rows = [supp({ scope: "site", refId: 0 })];
    expect(activeSuppression(rows, { ruleId: null, meterId: null, siteId: null }, D("2026-03-10T09:00:00Z"))).toBeNull();
  });
});

function shift(over: Partial<ShiftRow> = {}): ShiftRow {
  return {
    channelId: 1,
    dayOfWeekMask: 0b1111111,
    startMin: 8 * 60,
    endMin: 17 * 60,
    timezone: "UTC",
    enabled: true,
    ...over,
  };
}

describe("shiftCovers", () => {
  it("covers its own hours and not the ones outside", () => {
    expect(shiftCovers(shift(), D("2026-03-10T09:00:00Z"))).toBe(true);
    expect(shiftCovers(shift(), D("2026-03-10T07:59:00Z"))).toBe(false);
    expect(shiftCovers(shift(), D("2026-03-10T17:00:00Z"))).toBe(false);
  });

  it("equal start and end means all day", () => {
    const s = shift({ startMin: 0, endMin: 0 });
    expect(shiftCovers(s, D("2026-03-10T03:00:00Z"))).toBe(true);
    expect(shiftCovers(s, D("2026-03-10T23:59:00Z"))).toBe(true);
  });

  it("a disabled shift covers nothing", () => {
    expect(shiftCovers(shift({ enabled: false }), D("2026-03-10T09:00:00Z"))).toBe(false);
  });

  it("respects the day mask", () => {
    // 2026-03-10 is a Tuesday (dow 2). Mask with only Monday (bit 1) set.
    expect(shiftCovers(shift({ dayOfWeekMask: 0b0000010 }), D("2026-03-10T09:00:00Z"))).toBe(false);
    expect(shiftCovers(shift({ dayOfWeekMask: 0b0000100 }), D("2026-03-10T09:00:00Z"))).toBe(true);
  });

  it("reads the clock in the shift's own zone, not the server's", () => {
    // 07:00 UTC is 09:00 in Skopje (summer +2): inside an 08:00–17:00 local shift.
    const s = shift({ timezone: "Europe/Skopje" });
    expect(shiftCovers(s, D("2026-07-10T07:00:00Z"))).toBe(true);
    expect(shiftCovers(s, D("2026-07-10T05:00:00Z"))).toBe(false); // 07:00 local
  });

  it("a night shift wraps past midnight and belongs to the day it began", () => {
    // Friday 22:00 → 06:00. Mask = Friday only (bit 5).
    const night = shift({ startMin: 22 * 60, endMin: 6 * 60, dayOfWeekMask: 1 << 5 });
    expect(shiftCovers(night, D("2026-03-13T23:00:00Z"))).toBe(true); // Fri 23:00
    expect(shiftCovers(night, D("2026-03-14T02:00:00Z"))).toBe(true); // Sat 02:00, still Friday's night
    expect(shiftCovers(night, D("2026-03-13T02:00:00Z"))).toBe(false); // Fri 02:00 is Thursday's night
    expect(shiftCovers(night, D("2026-03-14T23:00:00Z"))).toBe(false); // Sat evening is not on the mask
  });
});

describe("onDutyChannelIds", () => {
  it("returns null when no rota is configured — the pre-rota behaviour", () => {
    expect(onDutyChannelIds([], D("2026-03-10T03:00:00Z"))).toBeNull();
  });

  it("returns null when every shift is disabled", () => {
    expect(onDutyChannelIds([shift({ enabled: false })], D("2026-03-10T09:00:00Z"))).toBeNull();
  });

  it("returns the covering channels", () => {
    const shifts = [
      shift({ channelId: 1, startMin: 8 * 60, endMin: 20 * 60 }),
      shift({ channelId: 2, startMin: 20 * 60, endMin: 8 * 60 }),
    ];
    expect(onDutyChannelIds(shifts, D("2026-03-10T09:00:00Z"))).toEqual(new Set([1]));
    expect(onDutyChannelIds(shifts, D("2026-03-10T22:00:00Z"))).toEqual(new Set([2]));
  });

  it("returns an empty set for an hour the rota does not cover", () => {
    const shifts = [shift({ channelId: 1, startMin: 8 * 60, endMin: 17 * 60 })];
    expect(onDutyChannelIds(shifts, D("2026-03-10T03:00:00Z"))).toEqual(new Set());
  });
});

describe("applyRota", () => {
  const chans = [{ id: 1 }, { id: 2 }, { id: 3 }];

  it("passes everything through when no rota exists", () => {
    expect(applyRota(chans, null)).toEqual({ channels: chans, gap: false });
  });

  it("keeps only the on-duty channels", () => {
    expect(applyRota(chans, new Set([2]))).toEqual({ channels: [{ id: 2 }], gap: false });
  });

  it("fails open on an uncovered hour rather than paging nobody", () => {
    const r = applyRota(chans, new Set<number>());
    expect(r.channels).toEqual(chans);
    expect(r.gap).toBe(true);
  });

  it("does not report a gap when there was nothing to notify anyway", () => {
    expect(applyRota([], new Set<number>())).toEqual({ channels: [], gap: false });
  });
});
