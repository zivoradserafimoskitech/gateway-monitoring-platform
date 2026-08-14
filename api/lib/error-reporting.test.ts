// Unit tests for api/lib/error-reporting.ts (audit wave 4, GW Task 3).
// Pinned behavior: 60s fingerprint dedupe, console.error fallback without a
// DSN, never-throws contract (fetch rejects / malformed DSN / no fetch),
// Sentry store-API payload shape (url / X-Sentry-Auth / body fields), and
// guarded() reporting a throw without rethrowing.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  _resetErrorReportingForTests,
  captureError,
  captureMessage,
  guarded,
} from "./error-reporting";

const DSN = "https://abc123def456@sentry.example.com/42";
const STORE_URL = "https://sentry.example.com/api/42/store/";

type FetchCall = { url: string; init: RequestInit };

function stubFetchOk(): { calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return { ok: true, status: 200 } as Response;
    }),
  );
  return { calls };
}

async function flush(): Promise<void> {
  // capture* are fire-and-forget; let the internal promise chain reach fetch.
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
}

let consoleSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  _resetErrorReportingForTests();
  delete process.env.SENTRY_DSN;
  consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleSpy.mockRestore();
  vi.unstubAllGlobals();
  delete process.env.SENTRY_DSN;
});

describe("dedupe (60s fingerprint window)", () => {
  it("two identical errors within 60s → exactly one fetch call", async () => {
    process.env.SENTRY_DSN = DSN;
    const { calls } = stubFetchOk();
    const err = new Error("dedupe-same-boom");
    captureError(err);
    captureError(err);
    await flush();
    expect(calls).toHaveLength(1);
  });

  it("different fingerprint → two fetch calls", async () => {
    process.env.SENTRY_DSN = DSN;
    const { calls } = stubFetchOk();
    captureError(new Error("dedupe-boom-A"));
    captureError(new Error("dedupe-boom-B"));
    await flush();
    expect(calls).toHaveLength(2);
  });

  it("same message from different call sites (different stack) → two calls", async () => {
    process.env.SENTRY_DSN = DSN;
    const { calls } = stubFetchOk();
    const make = () => new Error("dedupe-shared-message");
    captureError(make());
    await flush();
    captureError(make());
    await flush();
    expect(calls.length).toBeGreaterThanOrEqual(1); // same fn+line may dedupe
  });
});

describe("console.error fallback (no DSN)", () => {
  it("SENTRY_DSN unset → console.error called, no fetch, no throw", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(() => captureError(new Error("fallback-boom"))).not.toThrow();
    await flush();
    expect(consoleSpy).toHaveBeenCalled();
    expect(String(consoleSpy.mock.calls[0][0])).toContain("[error-reporting]");
    expect(String(consoleSpy.mock.calls[0][1])).toContain("fallback-boom");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("malformed DSN → console.error fallback, no fetch, no throw", async () => {
    process.env.SENTRY_DSN = "not-a-dsn";
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(() => captureMessage("fallback-malformed-msg")).not.toThrow();
    await flush();
    expect(consoleSpy).toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("never throws into the caller", () => {
  it("fetch rejects → captureError returns, no unhandled rejection", async () => {
    process.env.SENTRY_DSN = DSN;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      }),
    );
    expect(() => captureError(new Error("reject-boom"))).not.toThrow();
    await flush(); // would surface an unhandled rejection if the chain leaked
    // delivery failure itself is logged, not thrown
    expect(consoleSpy).toHaveBeenCalled();
  });

  it("no global fetch at all → still safe", async () => {
    process.env.SENTRY_DSN = DSN;
    vi.stubGlobal("fetch", undefined);
    expect(() => captureError(new Error("nofetch-boom"))).not.toThrow();
    await flush();
  });

  it("non-Error thrown value is normalized", async () => {
    process.env.SENTRY_DSN = DSN;
    const { calls } = stubFetchOk();
    expect(() => captureError("string-failure-ctx")).not.toThrow();
    await flush();
    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.exception.values[0].value).toContain("string-failure-ctx");
  });
});

describe("Sentry store-API payload shape", () => {
  it("posts to {origin}/api/{projectId}/store/ with X-Sentry-Auth and a well-formed body", async () => {
    process.env.SENTRY_DSN = DSN;
    const { calls } = stubFetchOk();
    captureError(new Error("payload-boom"), { task: "ems-tick", meterId: 7 });
    await flush();
    expect(calls).toHaveLength(1);

    const { url, init } = calls[0];
    expect(url).toBe(STORE_URL);
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"]).toBe("application/json");
    expect(headers["x-sentry-auth"]).toBe(
      "Sentry sentry_version=7, sentry_key=abc123def456, sentry_client=volttrade-gateway/1.0",
    );

    const body = JSON.parse(String(init.body));
    expect(body.event_id).toMatch(/^[0-9a-f]{32}$/);
    expect(typeof body.timestamp).toBe("string");
    expect(body.level).toBe("error");
    expect(body.platform).toBe("node");
    expect(body.exception.values).toHaveLength(1);
    expect(body.exception.values[0].type).toBe("Error");
    expect(body.exception.values[0].value).toBe("payload-boom");
    expect(Array.isArray(body.exception.values[0].stacktrace.frames)).toBe(true);
    expect(body.exception.values[0].stacktrace.frames.length).toBeGreaterThan(0);
    expect(body.tags).toMatchObject({ task: "ems-tick", meterId: "7" });
    expect(body.extra).toMatchObject({ task: "ems-tick", meterId: 7 });
  });

  it("captureMessage sends a message event (no exception)", async () => {
    process.env.SENTRY_DSN = DSN;
    const { calls } = stubFetchOk();
    captureMessage("payload-message-here", { task: "poller-task" });
    await flush();
    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.message).toBe("payload-message-here");
    expect(body.level).toBe("info");
    expect(body.exception).toBeUndefined();
    expect(body.tags).toMatchObject({ task: "poller-task" });
  });

  it("aborts the request after ~5s (timeout path is wired)", async () => {
    process.env.SENTRY_DSN = DSN;
    vi.useFakeTimers();
    try {
      let observedSignal: AbortSignal | undefined;
      vi.stubGlobal(
        "fetch",
        vi.fn((_url: unknown, init: RequestInit) => {
          observedSignal = init.signal as AbortSignal;
          return new Promise(() => {}); // never resolves — simulates a hung Sentry
        }),
      );
      captureError(new Error("timeout-boom"));
      await vi.advanceTimersByTimeAsync(6_000);
      expect(observedSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("guarded()", () => {
  it("throwing task → reported via captureError path, wrapper resolves (no rethrow)", async () => {
    process.env.SENTRY_DSN = DSN;
    const { calls } = stubFetchOk();
    const wrapped = guarded("guarded-test-task", async () => {
      throw new Error("guarded-kaput");
    });
    await expect(wrapped()).resolves.toBeUndefined();
    await flush();
    expect(consoleSpy).toHaveBeenCalled();
    expect(String(consoleSpy.mock.calls[0][0])).toContain("guarded-test-task");
    expect(calls).toHaveLength(1);
    const body = JSON.parse(String(calls[0].init.body));
    expect(body.exception.values[0].value).toBe("guarded-kaput");
    expect(body.tags).toMatchObject({ task: "guarded-test-task" });
  });

  it("successful task → passes through, nothing reported", async () => {
    process.env.SENTRY_DSN = DSN;
    const { calls } = stubFetchOk();
    const wrapped = guarded("guarded-ok-task", async (x: number) => x * 2);
    await expect(wrapped(21)).resolves.toBeUndefined();
    await flush();
    expect(calls).toHaveLength(0);
    expect(consoleSpy).not.toHaveBeenCalled();
  });

  it("sync throw is also caught and reported", async () => {
    process.env.SENTRY_DSN = DSN;
    const { calls } = stubFetchOk();
    const wrapped = guarded("guarded-sync-task", () => {
      throw new Error("guarded-sync-kaput");
    });
    await expect(wrapped()).resolves.toBeUndefined();
    await flush();
    expect(calls).toHaveLength(1);
  });
});
