// Signed firmware releases (Ed25519).
//
// The release manifest that is signed is the canonical string
//     "gmp-fw-v1\n<model>\n<version>\n<sha256 lowercase hex>"
// so a signature binds the exact image bytes (via sha256) to a model and
// version — a valid image cannot be replayed onto another model.
//
// Keys: OTA_SIGNING_PUBLIC_KEYS = "keyId:base64,keyId2:base64" where base64 is
// either a raw 32-byte Ed25519 public key or an SPKI DER. The PRIVATE key never
// touches the platform: releases are signed in the build pipeline
// (scripts/sign-firmware.ts is a reference) and the gateway firmware carries
// the same public keys to verify before flashing. OTA_REQUIRE_SIGNED=true
// refuses unsigned releases and ad-hoc firmware jobs.
import { createPublicKey, verify, type KeyObject } from "node:crypto";

const SPKI_ED25519_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function manifest(model: string, version: string, sha256: string): string {
  return `gmp-fw-v1\n${model}\n${version}\n${sha256.toLowerCase()}`;
}

export function parsePublicKey(b64: string): KeyObject {
  const raw = Buffer.from(b64.trim(), "base64");
  const der = raw.length === 32 ? Buffer.concat([SPKI_ED25519_PREFIX, raw]) : raw;
  const key = createPublicKey({ key: der, format: "der", type: "spki" });
  if (key.asymmetricKeyType !== "ed25519") throw new Error("signing key must be Ed25519");
  return key;
}

export function loadSigningKeys(env: string | undefined = process.env.OTA_SIGNING_PUBLIC_KEYS): Map<string, KeyObject> {
  const keys = new Map<string, KeyObject>();
  for (const part of (env ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf(":");
    if (i <= 0) throw new Error("OTA_SIGNING_PUBLIC_KEYS entries must be keyId:base64");
    keys.set(part.slice(0, i), parsePublicKey(part.slice(i + 1)));
  }
  return keys;
}

export function requireSigned(env: string | undefined = process.env.OTA_REQUIRE_SIGNED): boolean {
  return env === "true" || env === "1";
}

export type SignatureCheck = { ok: true } | { ok: false; reason: string };

export function verifyRelease(
  r: { model: string; version: string; sha256: string | null | undefined; signature: string | null | undefined; keyId: string | null | undefined },
  keys: Map<string, KeyObject>,
): SignatureCheck {
  if (!r.signature) return { ok: false, reason: "release is not signed" };
  if (!r.sha256) return { ok: false, reason: "a signed release needs sha256" };
  if (!r.keyId) return { ok: false, reason: "signingKeyId is required" };
  const key = keys.get(r.keyId);
  if (!key) return { ok: false, reason: `unknown signing key '${r.keyId}' (not in OTA_SIGNING_PUBLIC_KEYS)` };
  let sig: Buffer;
  try {
    sig = Buffer.from(r.signature, "base64");
  } catch {
    return { ok: false, reason: "signature is not base64" };
  }
  const good = verify(null, Buffer.from(manifest(r.model, r.version, r.sha256)), key, sig);
  return good ? { ok: true } : { ok: false, reason: "signature does not verify" };
}
