// §9.15: payload signing.
//
// Scheme (the one Stripe popularised, because receivers already have code for
// it and because it is the one that gets replay right):
//
//   X-VoltTrade-Signature: t=<unix seconds>,v1=<hex hmac-sha256>
//
// and the MAC is taken over `${t}.${rawBody}` — NOT over the body alone. That
// binding is the whole point: signing only the body means a captured request
// stays valid forever, because an attacker can replay it unchanged and the
// signature still verifies. With the timestamp inside the MAC, changing it
// breaks the signature and keeping it means the receiver can reject anything
// older than its tolerance.
//
// The receiver must compare in constant time and must re-serialize nothing:
// it signs the bytes it received, not a re-encoding of the parsed JSON, since
// JSON.parse followed by JSON.stringify does not round-trip key order.
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { SIGNATURE_TOLERANCE_SEC } from "@contracts/webhook-events";

export function newSecret(): string {
  return randomBytes(32).toString("hex");
}

/** The signed material: timestamp and body, joined so neither can be moved. */
export function signingPayload(timestampSec: number, rawBody: string): string {
  return `${timestampSec}.${rawBody}`;
}

export function signBody(secret: string, rawBody: string, timestampSec: number): string {
  const mac = createHmac("sha256", secret).update(signingPayload(timestampSec, rawBody)).digest("hex");
  return `t=${timestampSec},v1=${mac}`;
}

export interface ParsedSignature {
  timestampSec: number;
  mac: string;
}

export function parseSignature(header: string): ParsedSignature | null {
  let timestampSec: number | null = null;
  let mac: string | null = null;
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq <= 0) continue;
    const k = part.slice(0, eq).trim();
    const v = part.slice(eq + 1).trim();
    if (k === "t") {
      const n = Number(v);
      if (!Number.isFinite(n)) return null;
      timestampSec = n;
    } else if (k === "v1") {
      mac = v;
    }
  }
  if (timestampSec === null || mac === null) return null;
  return { timestampSec, mac };
}

/**
 * Verify a delivery. This is the reference implementation an integrator can
 * copy, and it is what our own tests check — a signer with no verifier beside
 * it is a scheme nobody can be sure they implemented correctly.
 *
 * Order matters: the MAC is checked BEFORE the clock. Rejecting on the
 * timestamp first would let an attacker probe which timestamps a receiver
 * accepts without ever holding the secret.
 */
export function verifySignature(
  secret: string,
  rawBody: string,
  header: string,
  nowSec: number = Math.floor(Date.now() / 1000),
  toleranceSec: number = SIGNATURE_TOLERANCE_SEC,
): boolean {
  const parsed = parseSignature(header);
  if (!parsed) return false;
  const expected = createHmac("sha256", secret)
    .update(signingPayload(parsed.timestampSec, rawBody))
    .digest();
  let given: Buffer;
  try {
    given = Buffer.from(parsed.mac, "hex");
  } catch {
    return false;
  }
  // timingSafeEqual throws on a length mismatch, which is itself an oracle if
  // the caller lets it escape; a wrong length is simply a wrong signature.
  if (given.length !== expected.length) return false;
  if (!timingSafeEqual(given, expected)) return false;
  return Math.abs(nowSec - parsed.timestampSec) <= toleranceSec;
}
