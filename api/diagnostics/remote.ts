// Remote diagnostics over MQTT.
//
// Request:  g2d/<uid>/diag  {"id","cmd","args"}
// Response: d2g/<uid>/diag  {"id","ok":bool,"output"?:string,"lines"?:string[],"error"?:string}
//
// Only a fixed allow-list of commands is sent; the gateway firmware must
// implement the same list (see docs/remote-diagnostics.md). Requests are kept
// in memory (bounded, TTL) — they are troubleshooting traffic, not records.
import { randomUUID } from "node:crypto";
import type { Gateway } from "@db/schema";

export const DIAG_COMMANDS = ["logs", "sysinfo", "netinfo", "ping", "modbus-scan", "restart-agent"] as const;
export type DiagCommand = (typeof DIAG_COMMANDS)[number];
/** Commands that change gateway state — operator+ and audited. */
export const DISRUPTIVE: ReadonlySet<DiagCommand> = new Set(["restart-agent"]);

export const DIAG_TIMEOUT_MS = Number(process.env.DIAG_TIMEOUT_MS ?? 30_000);
const MAX_KEEP = 500;
const KEEP_MS = 60 * 60_000;
const MAX_OUTPUT = 256 * 1024;

export interface DiagRequest {
  id: string;
  gatewayId: number;
  cmd: DiagCommand;
  args: Record<string, string | number>;
  requestedBy: number | null;
  status: "sent" | "ok" | "error" | "timeout";
  createdAt: number;
  completedAt: number | null;
  output: string | null;
  error: string | null;
}

const requests = new Map<string, DiagRequest>();

/** Validates/normalises arguments per command. Throws on bad input. */
export function validateArgs(cmd: DiagCommand, raw: Record<string, unknown> = {}): Record<string, string | number> {
  const int = (v: unknown, def: number, min: number, max: number) => {
    const n = v === undefined ? def : Number(v);
    if (!Number.isInteger(n) || n < min || n > max) throw new Error(`argument out of range ${min}..${max}`);
    return n;
  };
  switch (cmd) {
    case "logs": {
      const level = raw.level === undefined ? "info" : String(raw.level);
      if (!["debug", "info", "warn", "error"].includes(level)) throw new Error("level must be debug|info|warn|error");
      return { lines: int(raw.lines, 200, 1, 5000), level };
    }
    case "ping": {
      const host = String(raw.host ?? "");
      if (!/^[A-Za-z0-9.-]{1,253}$/.test(host)) throw new Error("host must be a hostname or IPv4 address");
      return { host, count: int(raw.count, 4, 1, 20) };
    }
    case "modbus-scan":
      return { from: int(raw.from, 1, 1, 247), to: int(raw.to, 10, 1, 247) };
    default:
      return {};
  }
}

function prune(now: number): void {
  for (const r of requests.values()) {
    if (r.status === "sent" && now - r.createdAt > DIAG_TIMEOUT_MS) {
      r.status = "timeout";
      r.completedAt = now;
    }
  }
  if (requests.size <= MAX_KEEP) {
    for (const [k, r] of requests) if (now - r.createdAt > KEEP_MS) requests.delete(k);
    return;
  }
  const extra = requests.size - MAX_KEEP;
  let i = 0;
  for (const k of requests.keys()) {
    if (i++ >= extra) break;
    requests.delete(k);
  }
}

export type Publisher = (gateway: Gateway, frame: Record<string, unknown>) => Promise<unknown>;

export async function sendDiag(
  gateway: Gateway,
  cmd: DiagCommand,
  rawArgs: Record<string, unknown> | undefined,
  requestedBy: number | null,
  publish: Publisher,
  now = Date.now(),
): Promise<DiagRequest> {
  const args = validateArgs(cmd, rawArgs);
  const req: DiagRequest = {
    id: randomUUID(), gatewayId: gateway.id, cmd, args, requestedBy,
    status: "sent", createdAt: now, completedAt: null, output: null, error: null,
  };
  prune(now);
  requests.set(req.id, req);
  try {
    await publish(gateway, { id: req.id, cmd, args });
  } catch (e) {
    req.status = "error";
    req.error = e instanceof Error ? e.message : String(e);
    req.completedAt = Date.now();
  }
  return req;
}

/** Handles a d2g/<uid>/diag frame. Returns the matched request or null. */
export function handleDiagResponse(gateway: Pick<Gateway, "id">, payload: Buffer | string, now = Date.now()): DiagRequest | null {
  let msg: { id?: unknown; ok?: unknown; output?: unknown; lines?: unknown; error?: unknown };
  try {
    msg = JSON.parse(payload.toString());
  } catch {
    return null;
  }
  if (typeof msg.id !== "string") return null;
  const req = requests.get(msg.id);
  // A response from a different gateway than the request went to is ignored.
  if (!req || req.gatewayId !== gateway.id || req.status !== "sent") return null;
  const text = Array.isArray(msg.lines) ? msg.lines.map(String).join("\n") : typeof msg.output === "string" ? msg.output : "";
  req.output = text.length > MAX_OUTPUT ? text.slice(-MAX_OUTPUT) : text;
  req.status = msg.ok === false ? "error" : "ok";
  req.error = msg.ok === false ? String(msg.error ?? "gateway reported failure") : null;
  req.completedAt = now;
  return req;
}

export function getDiag(id: string, now = Date.now()): DiagRequest | null {
  prune(now);
  return requests.get(id) ?? null;
}

export function listDiag(gatewayId: number, now = Date.now()): DiagRequest[] {
  prune(now);
  return [...requests.values()].filter((r) => r.gatewayId === gatewayId).sort((a, b) => b.createdAt - a.createdAt).slice(0, 50);
}

export function __resetDiag(): void {
  requests.clear();
}
