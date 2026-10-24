import { beforeEach, describe, expect, it } from "vitest";
import type { Gateway } from "@db/schema";
import { __resetDiag, DIAG_TIMEOUT_MS, getDiag, handleDiagResponse, listDiag, sendDiag, validateArgs } from "./remote";

const gw = { id: 7, uid: "GW7" } as Gateway;
const sent: Record<string, unknown>[] = [];
const pub = async (_g: Gateway, f: Record<string, unknown>) => { sent.push(f); };

describe("remote diagnostics", () => {
  beforeEach(() => { __resetDiag(); sent.length = 0; });

  it("validates arguments", () => {
    expect(validateArgs("logs", {})).toEqual({ lines: 200, level: "info" });
    expect(() => validateArgs("logs", { lines: 99999 })).toThrow();
    expect(() => validateArgs("ping", { host: "a; rm -rf /" })).toThrow();
    expect(validateArgs("ping", { host: "8.8.8.8" })).toEqual({ host: "8.8.8.8", count: 4 });
  });

  it("publishes and correlates a response", async () => {
    const r = await sendDiag(gw, "logs", { lines: 10 }, 1, pub, 1000);
    expect(sent[0]).toEqual({ id: r.id, cmd: "logs", args: { lines: 10, level: "info" } });
    expect(handleDiagResponse({ id: 8 }, JSON.stringify({ id: r.id, ok: true, lines: ["x"] }))).toBeNull();
    const done = handleDiagResponse(gw, Buffer.from(JSON.stringify({ id: r.id, ok: true, lines: ["a", "b"] })), 2000);
    expect(done?.status).toBe("ok");
    expect(getDiag(r.id, 2000)?.output).toBe("a\nb");
    expect(listDiag(7, 2000)).toHaveLength(1);
  });

  it("marks failures and timeouts", async () => {
    const bad = await sendDiag(gw, "sysinfo", {}, null, async () => { throw new Error("broker down"); }, 0);
    expect(bad.status).toBe("error");
    const r = await sendDiag(gw, "netinfo", {}, null, pub, 0);
    expect(getDiag(r.id, DIAG_TIMEOUT_MS + 1)?.status).toBe("timeout");
    expect(handleDiagResponse(gw, "not json")).toBeNull();
  });
});
