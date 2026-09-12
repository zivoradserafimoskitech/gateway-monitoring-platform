// Leader leases. The property that matters: exactly one replica may act, a
// dead holder hands over rather than blocking control forever, and a database
// failure means standing down rather than acting blind.
import { test, expect, vi, beforeEach, afterEach } from "vitest";

const execute = vi.fn();
vi.mock("../api/queries/connection", () => ({
  getDb: () => ({ execute }),
}));

const { acquireLease, hasLease, withLease, HOLDER_ID, DEFAULT_TTL_MS } = await import(
  "../api/lib/leader"
);

// The first execute() of the process creates the table; every later call is a
// lease statement. ok() shapes a mysql2 result header.
const ok = (affectedRows: number) => [{ affectedRows }, []];

beforeEach(() => {
  execute.mockReset();
  delete process.env.LEADER_LEASES;
});
afterEach(() => {
  delete process.env.LEADER_LEASES;
});

test("the holder id identifies this process", () => {
  expect(HOLDER_ID).toContain(String(process.pid));
  expect(DEFAULT_TTL_MS).toBeGreaterThan(0);
});

test("winning the insert makes this replica the leader", async () => {
  execute.mockResolvedValueOnce(ok(0)); // CREATE TABLE
  execute.mockResolvedValueOnce(ok(1)); // INSERT IGNORE won
  expect(await acquireLease("ems-controller")).toBe(true);
});

test("losing the insert but renewing an owned lease still leads", async () => {
  execute.mockResolvedValueOnce(ok(0)); // INSERT IGNORE lost (row exists)
  execute.mockResolvedValueOnce(ok(1)); // UPDATE matched: ours, or expired
  expect(await acquireLease("ems-controller")).toBe(true);
});

test("a lease held by a live peer is not stolen", async () => {
  execute.mockResolvedValueOnce(ok(0)); // INSERT IGNORE lost
  execute.mockResolvedValueOnce(ok(0)); // UPDATE matched nothing
  expect(await acquireLease("ems-controller")).toBe(false);
});

test("a database failure stands down rather than acting blind", async () => {
  // Every leased loop reads its instructions from that same database, so it
  // has nothing useful to do while the database is unreachable. Acting would
  // mean commanding plant on stale in-memory state.
  execute.mockRejectedValueOnce(new Error("connection refused"));
  expect(await acquireLease("ems-controller")).toBe(false);
});

test("withLease skips the work when the lease is held elsewhere", async () => {
  execute.mockResolvedValueOnce(ok(0));
  execute.mockResolvedValueOnce(ok(0));
  const work = vi.fn().mockResolvedValue("ran");
  expect(await withLease("ems-controller", work)).toBeUndefined();
  expect(work).not.toHaveBeenCalled();
});

test("withLease runs the work when the lease is held here", async () => {
  execute.mockResolvedValueOnce(ok(1));
  const work = vi.fn().mockResolvedValue("ran");
  expect(await withLease("ems-controller", work)).toBe("ran");
  expect(work).toHaveBeenCalledOnce();
});

test("LEADER_LEASES=off lets a single instance skip the round trip", async () => {
  process.env.LEADER_LEASES = "off";
  const work = vi.fn().mockResolvedValue("ran");
  expect(await hasLease("ems-controller")).toBe(true);
  expect(await withLease("ems-controller", work)).toBe("ran");
  expect(execute).not.toHaveBeenCalled();
});
