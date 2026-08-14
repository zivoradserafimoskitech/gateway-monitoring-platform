// Unit tests for audit #23 MFA primitives (api/lib/totp.ts).
// Pinned behavior: RFC 6238 vectors (SHA1/8-digit), AES-256-GCM roundtrip +
// tamper detection + key-derivation fallback, backup code format/hashing, and
// the pending-login store contract (TTL, single-use, max-attempts).
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  MfaNotConfiguredError,
  TOTP_PERIOD_S,
  createMfaPendingStore,
  decryptSecret,
  encryptSecret,
  generateBackupCodes,
  generateTotpCode,
  generateTotpSecret,
  hashBackupCode,
  looksLikeBackupCode,
  mfaConfigured,
  normalizeBackupCode,
  totpKeyUri,
  verifyTotp,
  verifyTotpCode,
} from "./totp";

// RFC 6238 Appendix B — SHA1, 8 digits, T0=0, X=30, secret = ASCII
// "12345678901234567890" → base32:
const RFC_SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const RFC_VECTORS: Array<[number, string]> = [
  [59, "94287082"],
  [1111111109, "07081804"],
  [1111111111, "14050471"],
  [1234567890, "89005924"],
  [2000000000, "69279037"],
  [20000000000, "65353130"],
];

describe("RFC 6238 test vectors (SHA1, 8 digits)", () => {
  for (const [epoch, expected] of RFC_VECTORS) {
    it(`T=${epoch} → ${expected}`, async () => {
      const code = await generateTotpCode(RFC_SECRET, { digits: 8, epoch });
      expect(code).toBe(expected);
    });
  }

  it("verifies an RFC vector code at its own epoch", async () => {
    expect(await verifyTotpCode(RFC_SECRET, "94287082", { epoch: 59, window: 0, digits: 8 })).toBe(true);
    expect(await verifyTotpCode(RFC_SECRET, "94287083", { epoch: 59, window: 0, digits: 8 })).toBe(false);
  });
});

describe("verifyTotpCode window semantics", () => {
  it("accepts the adjacent period with window=1, rejects beyond it", async () => {
    const code = await generateTotpCode(RFC_SECRET, { digits: 8, epoch: 59 }); // counter 1
    expect(await verifyTotpCode(RFC_SECRET, code, { epoch: 89, window: 1, digits: 8 })).toBe(true); // counter 2
    expect(await verifyTotpCode(RFC_SECRET, code, { epoch: 90, window: 1, digits: 8 })).toBe(false); // counter 3
  });

  it("rejects garbage codes", async () => {
    expect(await verifyTotpCode(RFC_SECRET, "000000", { epoch: 59 })).toBe(false);
  });
});

describe("encrypt/decrypt (AES-256-GCM at rest)", () => {
  const KEY = "a".repeat(64); // 32 bytes hex
  const savedKey = process.env.MFA_ENCRYPTION_KEY;
  const savedSession = process.env.SESSION_SECRET;

  beforeEach(() => {
    delete process.env.MFA_ENCRYPTION_KEY;
    delete process.env.SESSION_SECRET;
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.MFA_ENCRYPTION_KEY;
    else process.env.MFA_ENCRYPTION_KEY = savedKey;
    if (savedSession === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = savedSession;
  });

  it("roundtrips a secret with MFA_ENCRYPTION_KEY", () => {
    process.env.MFA_ENCRYPTION_KEY = KEY;
    const secret = generateTotpSecret();
    const enc = encryptSecret(secret);
    expect(enc).toMatch(/^v1:[0-9a-f]{24}:[0-9a-f]{32}:[0-9a-f]+$/);
    expect(enc).not.toContain(secret);
    expect(decryptSecret(enc)).toBe(secret);
  });

  it("produces different ciphertexts for the same secret (random IV)", () => {
    process.env.MFA_ENCRYPTION_KEY = KEY;
    const secret = generateTotpSecret();
    expect(encryptSecret(secret)).not.toBe(encryptSecret(secret));
  });

  it("detects tampering via the GCM auth tag", () => {
    process.env.MFA_ENCRYPTION_KEY = KEY;
    const enc = encryptSecret(generateTotpSecret());
    const parts = enc.split(":");
    parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith("00") ? "01" : "00");
    expect(() => decryptSecret(parts.join(":"))).toThrow();
  });

  it("rejects a wrong key", () => {
    process.env.MFA_ENCRYPTION_KEY = KEY;
    const enc = encryptSecret(generateTotpSecret());
    process.env.MFA_ENCRYPTION_KEY = "b".repeat(64);
    expect(() => decryptSecret(enc)).toThrow();
  });

  it("derives a stable key from SESSION_SECRET when MFA_ENCRYPTION_KEY is absent", () => {
    process.env.SESSION_SECRET = "test-session-secret";
    const a = encryptSecret("JBSWY3DPEHPK3PXP");
    const b = encryptSecret("JBSWY3DPEHPK3PXP");
    expect(decryptSecret(a)).toBe("JBSWY3DPEHPK3PXP");
    expect(decryptSecret(b)).toBe("JBSWY3DPEHPK3PXP");
    // different session secret → cannot decrypt
    process.env.SESSION_SECRET = "other-secret";
    expect(() => decryptSecret(a)).toThrow();
  });

  it("throws MfaNotConfiguredError when no key source exists", () => {
    expect(mfaConfigured()).toBe(false);
    expect(() => encryptSecret("JBSWY3DPEHPK3PXP")).toThrow(MfaNotConfiguredError);
    expect(() => decryptSecret("v1:00:00:00")).toThrow(/MFA not configured on server/);
    process.env.MFA_ENCRYPTION_KEY = KEY;
    expect(mfaConfigured()).toBe(true);
  });

  it("rejects a malformed MFA_ENCRYPTION_KEY", () => {
    process.env.MFA_ENCRYPTION_KEY = "not-hex";
    expect(() => encryptSecret("JBSWY3DPEHPK3PXP")).toThrow(/64 hex/);
  });
});

describe("verifyTotp (encrypted-secret path)", () => {
  const KEY = "c".repeat(64);
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.MFA_ENCRYPTION_KEY;
    process.env.MFA_ENCRYPTION_KEY = KEY;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.MFA_ENCRYPTION_KEY;
    else process.env.MFA_ENCRYPTION_KEY = saved;
  });

  it("verifies a live code against the encrypted secret", async () => {
    const secret = generateTotpSecret();
    const enc = encryptSecret(secret);
    const code = await generateTotpCode(secret);
    expect(await verifyTotp(enc, code, null)).not.toBeNull();
    expect(await verifyTotp(enc, code === "000000" ? "000001" : "000000", null)).toBeNull();
  });

  // audit wave4 — this is the test that proves replay protection:
  it("rejects replay of an already-used code", async () => {
    const secret = generateTotpSecret();
    const enc = encryptSecret(secret);
    const code = await generateTotpCode(secret);
    const step = await verifyTotp(enc, code, null);
    expect(step).not.toBeNull();
    expect(await verifyTotp(enc, code, step)).toBeNull(); // same code again
  });

  it("returns the accepted step number (current 30s step)", async () => {
    vi.useFakeTimers();
    try {
      const t0 = 1_700_000_123_000; // fixed "now"
      vi.setSystemTime(t0);
      const secret = generateTotpSecret();
      const enc = encryptSecret(secret);
      const code = await generateTotpCode(secret, { epoch: Math.floor(t0 / 1000) });
      const expected = Math.floor(t0 / 1000 / TOTP_PERIOD_S);
      expect(await verifyTotp(enc, code, null)).toBe(expected);
    } finally {
      vi.useRealTimers();
    }
  });

  it("accepts the adjacent step within window=1 unless it was already used", async () => {
    vi.useFakeTimers();
    try {
      const t0 = 1_700_000_123_000;
      vi.setSystemTime(t0);
      const secret = generateTotpSecret();
      const enc = encryptSecret(secret);
      const currentStep = Math.floor(t0 / 1000 / TOTP_PERIOD_S);
      // code generated for the PREVIOUS step (inside the ±1 window)
      const prevCode = await generateTotpCode(secret, { epoch: (currentStep - 1) * TOTP_PERIOD_S });
      expect(await verifyTotp(enc, prevCode, currentStep - 2)).toBe(currentStep - 1);
      // ...but if the user already authenticated at the current (later) step,
      // the older code is a replay and must be refused.
      expect(await verifyTotp(enc, prevCode, currentStep)).toBeNull();
      expect(await verifyTotp(enc, prevCode, currentStep - 1)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("returns null instead of throwing for a malformed token (backup-code-shaped)", async () => {
    const secret = generateTotpSecret();
    const enc = encryptSecret(secret);
    await expect(verifyTotp(enc, "abcd-ef12", null)).resolves.toBeNull();
    await expect(verifyTotp(enc, "not-a-token", null)).resolves.toBeNull();
  });
});

describe("totpKeyUri", () => {
  it("builds an otpauth:// URI with issuer + label", () => {
    const uri = totpKeyUri("user@example.com", RFC_SECRET);
    expect(uri).toContain("otpauth://totp/");
    expect(uri).toContain("VoltTrade%20Cloud");
    expect(uri).toContain("user%40example.com");
    expect(uri).toContain(`secret=${RFC_SECRET}`);
  });
});

describe("backup codes", () => {
  it("generates 8 unique xxxx-xxxx codes with matching hashes", () => {
    const { raw, hashes } = generateBackupCodes();
    expect(raw).toHaveLength(8);
    expect(hashes).toHaveLength(8);
    expect(new Set(raw).size).toBe(8);
    for (let i = 0; i < 8; i++) {
      expect(raw[i]).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}$/);
      expect(hashes[i]).toMatch(/^[0-9a-f]{64}$/);
      expect(hashes[i]).toBe(hashBackupCode(raw[i]));
      // single-use semantics are enforced by the router marking used_at —
      // pinned here: a code's hash never matches a DIFFERENT code.
      expect(hashBackupCode(raw[i])).not.toBe(hashBackupCode(raw[(i + 1) % 8]));
    }
  });

  it("normalization is case/whitespace-insensitive", () => {
    expect(normalizeBackupCode("  AB12-CD34 ")).toBe("ab12-cd34");
    expect(hashBackupCode("AB12-CD34")).toBe(hashBackupCode("ab12-cd34"));
  });

  it("looksLikeBackupCode distinguishes formats", () => {
    expect(looksLikeBackupCode("ab12-cd34")).toBe(true);
    expect(looksLikeBackupCode("123456")).toBe(false);
    expect(looksLikeBackupCode("ab12cd34")).toBe(false);
  });
});

describe("pending-login store (TTL + single-use + max attempts)", () => {
  it("create → peek → consume is single-use", () => {
    const store = createMfaPendingStore({ now: () => 1000 });
    const token = store.create(42);
    expect(store.peek(token)?.userId).toBe(42);
    expect(store.consume(token)?.userId).toBe(42);
    expect(store.consume(token)).toBeNull(); // second use rejected
    expect(store.peek(token)).toBeNull();
    expect(store.size()).toBe(0);
  });

  it("expires entries after the TTL", () => {
    let t = 1000;
    const store = createMfaPendingStore({ ttlMs: 5 * 60_000, now: () => t });
    const token = store.create(7);
    t += 5 * 60_000 - 1;
    expect(store.peek(token)).not.toBeNull();
    t += 2; // past TTL
    expect(store.peek(token)).toBeNull();
    expect(store.consume(token)).toBeNull();
    expect(store.size()).toBe(0); // swept
  });

  it("destroys the challenge after maxAttempts failures", () => {
    const store = createMfaPendingStore({ maxAttempts: 5, now: () => 1000 });
    const token = store.create(9);
    for (let i = 1; i < 5; i++) {
      const r = store.fail(token);
      expect(r.attempts).toBe(i);
      expect(r.destroyed).toBe(false);
    }
    const last = store.fail(token);
    expect(last).toEqual({ attempts: 5, destroyed: true });
    expect(store.peek(token)).toBeNull(); // must log in again
    expect(store.consume(token)).toBeNull();
  });

  it("fail on an unknown/expired token is a no-op", () => {
    const store = createMfaPendingStore({ now: () => 1000 });
    expect(store.fail("nope")).toEqual({ attempts: 0, destroyed: false });
  });

  it("tokens are unique and unpredictable-looking", () => {
    const store = createMfaPendingStore({ now: () => 1000 });
    const a = store.create(1);
    const b = store.create(1);
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(store.size()).toBe(2);
  });
});

describe("verifyTotpCode malformed input (live e2e finding)", () => {
  it("returns false instead of throwing for a backup-code-shaped token", async () => {
    const secret = generateTotpSecret();
    await expect(verifyTotpCode(secret, "abcd-ef12")).resolves.toBe(false);
  });
  it("returns false instead of throwing for an empty/garbage token", async () => {
    const secret = generateTotpSecret();
    await expect(verifyTotpCode(secret, "not-a-token")).resolves.toBe(false);
  });
});
