// §9.4: the emergency stop's contract, pinned where it can actually be
// checked — at the chokepoint's own module boundary.
//
// The property that matters is not "a locked device is refused" (that is one
// if-statement) but WHERE the check sits: executeControl is the single
// function every writer passes through — manual control, the grid connection
// limit, peak shaving, optimizer plans, schedules and the watchdog refresh.
// A lock enforced in the router, or in each controller, would be inherited by
// none of them and forgotten by the next one added. These tests read the
// source to hold that structure in place, because no unit test of the happy
// path can tell the difference.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

const execute = readFileSync("api/control/execute.ts", "utf8");
const controller = readFileSync("api/ems/controller.ts", "utf8");
const controlRouter = readFileSync("api/routers/control.ts", "utf8");

describe("emergency stop enforcement", () => {
  it("is enforced inside executeControl, not at a caller", () => {
    const body = execute.slice(execute.indexOf("export async function executeControl"));
    expect(body).toContain("controlLock(meter.id)");
    // Before the transport branch: a lock that was checked after the write
    // would be a report, not a stop.
    expect(body.indexOf("controlLock(meter.id)")).toBeLessThan(body.indexOf("if (meter.host)"));
  });

  it("reads the lock from the database rather than the passed meter row", () => {
    // Meter rows reach this function from caches with multi-minute lifetimes.
    // A stop that takes effect in five minutes is not a stop.
    expect(execute).toMatch(/async function controlLock[\s\S]*?\.from\(meters\)/);
    expect(execute).not.toMatch(/meter\.controlLockedAt/);
  });

  it("lets a dry run through to report on the lock instead of refusing", () => {
    // Describing a write is not performing one, and "what would happen here"
    // is most useful precisely when the answer is "nothing, it is stopped".
    expect(execute).toContain("opts.dryRun ? null : await controlLock(meter.id)");
  });

  it("keeps rehearsals out of the command audit trail", () => {
    // The commands table is the record of what reached plant. A preview row in
    // it would be indistinguishable from a real command in the one place an
    // incident review looks.
    //
    // Asserted on the SIGNATURE and the call, not on the string "dryRun"
    // appearing somewhere in the function: the first version of this test
    // forbade the word outright and then failed on a comment explaining why
    // the parameter is absent. A test that cannot tell code from prose about
    // the code will keep costing a cycle for no finding.
    const signature = execute.slice(
      execute.indexOf("export async function executeAndLog"),
      execute.indexOf("{", execute.indexOf("export async function executeAndLog")),
    );
    expect(signature).not.toContain("dryRun");
    // ...and it calls executeControl with no options argument, so it cannot
    // request a dry run even by accident.
    const body = execute.slice(execute.indexOf("export async function executeAndLog"));
    expect(body).toContain("await executeControl(meter, key, value)");
  });

  it("makes that a type rather than a convention", () => {
    // "preview" sits outside LiveControlStatus, which is what the commands
    // table accepts, so the compiler refuses the insert. Typecheck caught this
    // when the status union first widened — the guard is what keeps it caught
    // rather than a comment asking the next person to remember.
    expect(execute).toContain('export type LiveControlStatus = "ok" | "sent" | "failed"');
    expect(execute).toContain('status: LiveControlStatus | "preview"');
    const log = execute.slice(execute.indexOf("export async function executeAndLog"));
    expect(log).toContain('result.status === "preview"');
  });

  it("routes every EMS writer through the guarded chokepoint", () => {
    // If a future controller writes with its own Modbus client, the lock stops
    // applying to it and this test is how that gets noticed.
    expect(controller).not.toMatch(/new ModbusRTU\(/);
    expect(controller).toMatch(/executeAndLog|executeControl/);
  });

  it("gates the stop itself behind the operator role", () => {
    const setLock = controlRouter.slice(controlRouter.indexOf("setLock:"));
    expect(setLock.slice(0, 40)).toContain("operator");
  });
});

describe("emergency stop ordering", () => {
  it("drives the device to a safe state BEFORE engaging the lock", () => {
    // The lock refuses every write including the safe-state one, so the order
    // is what decides whether an emergency stop actually stops anything.
    const setLock = controlRouter.slice(
      controlRouter.indexOf("setLock:"),
      controlRouter.indexOf("history: authed"),
    );
    const safeState = setLock.indexOf("executeAndLog(meter, key, 0");
    const engage = setLock.indexOf("controlLockedAt: new Date()");
    expect(safeState).toBeGreaterThan(-1);
    expect(engage).toBeGreaterThan(-1);
    expect(safeState).toBeLessThan(engage);
  });

  it("engages the lock even when the safe-state write fails", () => {
    // A device that cannot be reached is exactly the case where the stop
    // matters most; failing to reach it must not prevent the lock.
    const setLock = controlRouter.slice(controlRouter.indexOf("setLock:"));
    expect(setLock).toContain("safe-state write failed");
  });
});
