// §9.15: the signature scheme. A signer with no verifier beside it is a scheme
// nobody can be sure they implemented correctly, so the tests drive both ends.
import { describe, it, expect } from "vitest";
import { newSecret, parseSignature, signBody, signingPayload, verifySignature } from "../api/webhooks/sign";
import { SIGNATURE_TOLERANCE_SEC } from "../contracts/webhook-events";

const SECRET = "0123456789abcdef0123456789abcdef";
const BODY = JSON.stringify({ id: 7, event: "alarm.raised", data: { alarmId: 42 } });
const T = 1_774_000_000;

describe("signBody / verifySignature", () => {
  it("round-trips", () => {
    const header = signBody(SECRET, BODY, T);
    expect(verifySignature(SECRET, BODY, header, T)).toBe(true);
  });

  it("emits the documented header shape", () => {
    const header = signBody(SECRET, BODY, T);
    expect(header).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(parseSignature(header)).toEqual({ timestampSec: T, mac: header.slice(header.indexOf("v1=") + 3) });
  });

  it("rejects a tampered body", () => {
    const header = signBody(SECRET, BODY, T);
    expect(verifySignature(SECRET, BODY.replace("42", "43"), header, T)).toBe(false);
  });

  it("rejects the wrong secret", () => {
    const header = signBody(SECRET, BODY, T);
    expect(verifySignature("f".repeat(32), BODY, header, T)).toBe(false);
  });

  it("binds the timestamp into the MAC, so a replay cannot be re-stamped", () => {
    const header = signBody(SECRET, BODY, T);
    const moved = header.replace(`t=${T}`, `t=${T + 10_000}`);
    // The MAC covers `${t}.${body}`, so moving the clock forward to get inside
    // the tolerance window invalidates the signature instead.
    expect(verifySignature(SECRET, BODY, moved, T + 10_000)).toBe(false);
  });

  it("rejects a delivery older than the tolerance", () => {
    const header = signBody(SECRET, BODY, T);
    expect(verifySignature(SECRET, BODY, header, T + SIGNATURE_TOLERANCE_SEC)).toBe(true);
    expect(verifySignature(SECRET, BODY, header, T + SIGNATURE_TOLERANCE_SEC + 1)).toBe(false);
  });

  it("rejects a delivery from the future by the same margin", () => {
    const header = signBody(SECRET, BODY, T);
    expect(verifySignature(SECRET, BODY, header, T - SIGNATURE_TOLERANCE_SEC - 1)).toBe(false);
  });

  it("rejects malformed headers without throwing", () => {
    for (const h of ["", "garbage", "t=abc,v1=ff", "v1=ff", `t=${T}`, `t=${T},v1=zz`, `t=${T},v1=`]) {
      expect(verifySignature(SECRET, BODY, h, T)).toBe(false);
    }
  });

  it("rejects a MAC of the wrong length instead of throwing", () => {
    // timingSafeEqual throws on a length mismatch; a short signature is simply
    // a wrong signature, and must not take the receiver down.
    expect(verifySignature(SECRET, BODY, `t=${T},v1=abcd`, T)).toBe(false);
  });

  it("signs the timestamp and body joined, not concatenated ambiguously", () => {
    expect(signingPayload(T, BODY)).toBe(`${T}.${BODY}`);
  });

  it("generates a distinct 256-bit secret each time", () => {
    const a = newSecret();
    const b = newSecret();
    expect(a).toHaveLength(64);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});
