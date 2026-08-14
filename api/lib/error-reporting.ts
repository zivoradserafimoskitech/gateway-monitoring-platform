// Error reporting (audit wave 4, GW Task 3).
//
// Until now nothing told a human when a background task failed: the EMS tick
// throwing at 03:00, a scheduled report failing, an unhandled rejection — all
// vanished into the process log. The watchdog and /metrics cover steady state,
// not exceptions.
//
// This is a MINIMAL reporter that speaks Sentry's HTTP store API directly.
// We deliberately do NOT add @sentry/node: this runs on plant equipment and
// the SDK's transitive tree is far too large for the fraction of its features
// we need (capture exception/message + tags). The store API is one POST.
//
// Contract (holds for every export here):
//  - captureError/captureMessage are fire-and-forget: they never throw into
//    the caller and their internal promise rejections are swallowed. It must
//    be safe to call them unconditionally — no DSN, malformed DSN, no global
//    fetch, network down: worst case is a console.error line.
//  - Identical fingerprints (message + first application stack frame) are
//    deduped for ~60s so an error burst is not an alert burst.
//  - installErrorHandlers() wires unhandledRejection/uncaughtException. On
//    uncaughtException the process reports, logs, then EXITS — a process in
//    an unknown state must stop rather than keep commanding plant (the
//    watchdog/systemd restarts it). ~1s is allowed for the report to flush.
//  - guarded(name, fn) wraps a periodic task: a throw is reported + logged
//    and NOT rethrown, so the loop continues its next cycle (same behavior
//    as today's try/catch loops, plus reporting).

import { randomUUID } from "node:crypto";

const DEDUPE_MS = 60_000;
const MAX_DEDUPE_ENTRIES = 5_000;
const FETCH_TIMEOUT_MS = 5_000;
const CLIENT_NAME = "volttrade-gateway/1.0";

export type ErrorContext = Record<string, unknown>;

interface ParsedDsn {
  storeUrl: string;
  key: string;
}

interface Frame {
  filename?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
}

// fingerprint → last report timestamp (ms). In-process only — a restart
// re-reports, which is acceptable (and desirable) for crash loops.
const seen = new Map<string, number>();

/** Parse `https://{key}@{host}/{projectId}` into a store-API endpoint. Null on any malformation. */
function parseDsn(dsn: string): ParsedDsn | null {
  try {
    const u = new URL(dsn);
    const key = u.username;
    const segments = u.pathname.split("/").filter(Boolean);
    const projectId = segments[segments.length - 1];
    if (!key || !projectId) return null;
    return { storeUrl: `${u.protocol}//${u.host}/api/${projectId}/store/`, key };
  } catch {
    return null;
  }
}

/** Parse a V8 stack into Sentry frames (oldest call first, crash site last). */
function parseStack(stack: string | undefined): Frame[] {
  if (!stack) return [];
  const frames: Frame[] = [];
  for (const line of stack.split("\n").slice(1)) {
    const m = line.match(/at\s+(?:(.*?)\s+\()?(.+?):(\d+):(\d+)\)?\s*$/);
    if (!m) continue;
    const filename = m[2];
    frames.push({
      filename,
      function: m[1] || undefined,
      lineno: Number(m[3]),
      colno: Number(m[4]),
      in_app: !filename.includes("node_modules") && !filename.startsWith("node:"),
    });
  }
  return frames.reverse();
}

/** First application frame ("file:line") from the TOP of the stack — the crash site. */
function firstAppFrame(stack: string | undefined): string {
  if (!stack) return "";
  for (const line of stack.split("\n").slice(1)) {
    const m = line.match(/at\s+(?:.*?\s+\()?(.+?):(\d+):(\d+)\)?\s*$/);
    if (!m) continue;
    const filename = m[1];
    if (filename.includes("node_modules") || filename.startsWith("node:")) continue;
    return `${filename}:${m[2]}`;
  }
  return "";
}

/** True when this fingerprint was already reported within the dedupe window. */
function isDuplicate(fingerprint: string): boolean {
  const now = Date.now();
  const last = seen.get(fingerprint);
  if (last !== undefined && now - last < DEDUPE_MS) return true;
  seen.set(fingerprint, now);
  // Bound the map: evict oldest (insertion-ordered) past the cap.
  if (seen.size > MAX_DEDUPE_ENTRIES) {
    const excess = seen.size - MAX_DEDUPE_ENTRIES;
    let dropped = 0;
    for (const key of seen.keys()) {
      if (dropped++ >= excess) break;
      seen.delete(key);
    }
  }
  return false;
}

function toTags(ctx: ErrorContext | undefined): Record<string, string> | undefined {
  if (!ctx) return undefined;
  const tags: Record<string, string> = {};
  for (const [k, v] of Object.entries(ctx)) {
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") tags[k] = String(v);
  }
  return Object.keys(tags).length > 0 ? tags : undefined;
}

function buildEvent(
  level: "error" | "info",
  err: Error | null,
  message: string,
  ctx: ErrorContext | undefined,
): Record<string, unknown> {
  const event: Record<string, unknown> = {
    event_id: randomUUID().replace(/-/g, ""),
    timestamp: new Date().toISOString(),
    level,
    platform: "node",
  };
  if (err) {
    event.exception = {
      values: [
        {
          type: err.name || "Error",
          value: err.message,
          stacktrace: { frames: parseStack(err.stack) },
        },
      ],
    };
  } else {
    event.message = message;
  }
  const tags = toTags(ctx);
  if (tags) event.tags = tags;
  if (ctx && Object.keys(ctx).length > 0) event.extra = ctx;
  return event;
}

async function postEvent(dsn: ParsedDsn, event: Record<string, unknown>): Promise<void> {
  if (typeof fetch !== "function") return; // pre-18 Node or stubbed-out env — fallback already logged
  const ac = new AbortController();
  const timeout = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  try {
    await fetch(dsn.storeUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-sentry-auth": `Sentry sentry_version=7, sentry_key=${dsn.key}, sentry_client=${CLIENT_NAME}`,
      },
      body: JSON.stringify(event),
      signal: ac.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function report(level: "error" | "info", err: Error | null, message: string, ctx?: ErrorContext): void {
  const fingerprint = `${message}|${err ? firstAppFrame(err.stack) : ""}`;
  if (isDuplicate(fingerprint)) return;

  const dsnRaw = process.env.SENTRY_DSN;
  const dsn = dsnRaw && dsnRaw.trim() !== "" ? parseDsn(dsnRaw) : null;
  if (!dsn) {
    // No DSN (or malformed): the process log is the only sink. This is the
    // documented degradation — safe to call unconditionally.
    console.error("[error-reporting]", message, err?.stack ?? "", ctx ?? "");
    return;
  }
  void postEvent(dsn, buildEvent(level, err, message, ctx)).catch((postErr) => {
    // Network down / Sentry unreachable must never surface to the caller —
    // drop to the log so the failure is at least visible somewhere.
    console.error(
      "[error-reporting] failed to deliver event:",
      postErr instanceof Error ? postErr.message : postErr,
      "| original:",
      message,
    );
  });
}

/**
 * Report an exception. Fire-and-forget: returns void, never throws, never
 * rejects. `ctx` is attached as Sentry tags (scalar values) + extra.
 */
export function captureError(err: unknown, ctx?: ErrorContext): void {
  try {
    const e = err instanceof Error ? err : new Error(typeof err === "string" ? err : String(err));
    report("error", e, e.message, ctx);
  } catch {
    /* reporting must never break the caller */
  }
}

/** Report a message (level "info" unless ctx.level === "error"). Same never-throw contract as captureError. */
export function captureMessage(msg: string, ctx?: ErrorContext): void {
  try {
    const level = ctx?.level === "error" ? "error" : "info";
    report(level, null, String(msg), ctx);
  } catch {
    /* reporting must never break the caller */
  }
}

let handlersInstalled = false;

/**
 * Wire process-level handlers. Call EARLY in boot (right after imports):
 *  - unhandledRejection → report, keep running (a rejected promise leaves the
 *    process in a known state; killing the loop would be worse).
 *  - uncaughtException → report + log + exit(1) after a ~1s flush window. A
 *    process in an unknown state must stop rather than keep commanding plant;
 *    the watchdog/systemd restarts it.
 */
export function installErrorHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  process.on("unhandledRejection", (reason) => {
    captureError(reason instanceof Error ? reason : new Error(`unhandledRejection: ${String(reason)}`), {
      source: "unhandledRejection",
    });
  });
  process.on("uncaughtException", (err) => {
    console.error("[fatal] uncaughtException:", err instanceof Error ? (err.stack ?? err.message) : err);
    captureError(err, { source: "uncaughtException" });
    setTimeout(() => process.exit(1), 1000).unref();
  });
}

/**
 * Wrap a periodic task so a throw is reported + logged instead of vanishing
 * (or killing the loop). The wrapper NEVER rethrows: the task continues its
 * next cycle, exactly like today's try/catch loops — this is purely additive
 * reporting. EMS interlocks are unaffected (successful-path behavior is
 * unchanged).
 */
export function guarded<A extends unknown[]>(
  name: string,
  fn: (...args: A) => Promise<unknown> | unknown,
): (...args: A) => Promise<void> {
  return async (...args: A): Promise<void> => {
    try {
      await fn(...args);
    } catch (err) {
      console.error(`[${name}] failed:`, err instanceof Error ? err.message : err);
      captureError(err, { task: name });
    }
  };
}

/** Test-only: clear dedupe state so cases are independent. */
export function _resetErrorReportingForTests(): void {
  seen.clear();
}
