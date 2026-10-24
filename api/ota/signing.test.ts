import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { loadSigningKeys, manifest, requireSigned, verifyRelease } from "./signing";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const rawPub = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("base64");
const sha = "a".repeat(64);
const sig = sign(null, Buffer.from(manifest("G30", "2.1.0", sha)), privateKey).toString("base64");

describe("firmware signing", () => {
  const keys = loadSigningKeys(`prod-1:${rawPub}`);
  it("verifies a good signature", () => {
    expect(verifyRelease({ model: "G30", version: "2.1.0", sha256: sha, signature: sig, keyId: "prod-1" }, keys)).toEqual({ ok: true });
  });
  it("rejects replay onto another model/version or image", () => {
    expect(verifyRelease({ model: "C30", version: "2.1.0", sha256: sha, signature: sig, keyId: "prod-1" }, keys).ok).toBe(false);
    expect(verifyRelease({ model: "G30", version: "2.1.0", sha256: "b".repeat(64), signature: sig, keyId: "prod-1" }, keys).ok).toBe(false);
  });
  it("rejects unknown keys and unsigned releases", () => {
    expect(verifyRelease({ model: "G30", version: "2.1.0", sha256: sha, signature: sig, keyId: "x" }, keys).ok).toBe(false);
    expect(verifyRelease({ model: "G30", version: "2.1.0", sha256: sha, signature: null, keyId: null }, keys).ok).toBe(false);
  });
  it("parses config", () => {
    expect(loadSigningKeys(undefined).size).toBe(0);
    expect(() => loadSigningKeys("nocolon")).toThrow();
    expect(requireSigned("true")).toBe(true);
    expect(requireSigned(undefined)).toBe(false);
  });
});
