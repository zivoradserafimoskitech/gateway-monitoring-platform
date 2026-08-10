// Pure helpers for poller scheduling — kept free of DB/modbus imports so unit
// tests can exercise them without side effects (v5, findings #10–#12).

export const BACKOFF_BASE_MS = 10_000;
export const BACKOFF_MAX_MS = 300_000;

/** Exponential backoff: 10s → 20s → 40s … capped at 5 min. */
export function nextBackoffMs(currentMs: number): number {
  return Math.min(BACKOFF_MAX_MS, (currentMs > 0 ? currentMs : BACKOFF_BASE_MS / 2) * 2);
}

const TRANSPORT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EAI_AGAIN",
]);

/**
 * Distinguish socket-level failures (drop + reconnect) from device-level
 * failures (Modbus exceptions, per-unit read timeouts). Dropping the shared
 * socket on a device-level error kills every other unit polled over the same
 * host:port (v4 finding #10), so only true transport errors qualify.
 * A read "Timed out" is treated as device-level: one dead unit must not
 * disconnect the healthy units sharing the socket.
 */
export function isTransportError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const e = err as { code?: string; errno?: string; message?: string };
  const code = e.code ?? e.errno;
  if (code && TRANSPORT_CODES.has(code)) return true;
  const m = (e.message ?? "").toLowerCase();
  return (
    m.includes("port not open") ||
    m.includes("socket closed") ||
    m.includes("connection closed") ||
    m.includes("connection refused") ||
    m.includes("connection reset")
  );
}
