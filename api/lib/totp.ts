// audit #23: TOTP MFA (RFC 6238) via otplib v13.
//  - Secrets are AES-256-GCM encrypted at rest (key from MFA_ENCRYPTION_KEY,
//    derived from SESSION_SECRET as fallback).
//  - 8 single-use backup codes per user, sha256-hashed (same discipline as
//    API keys: raw codes are shown exactly once).
//  - In-memory pending-login store for the 2-step login challenge (5 min TTL,
//    single-use, max 5 attempts) — same process-local pattern as the login
//    limiter in api/routers/auth.ts.
import crypto from "node:crypto";
import { generate, verify, generateSecret, generateURI } from "otplib";

export const MFA_ISSUER = "VoltTrade Cloud";
export const TOTP_PERIOD_S = 30;
export const BACKUP_CODE_COUNT = 8;
export const MFA_PENDING_TTL_MS = 5 * 60_000;
export const MFA_PENDING_MAX_ATTEMPTS = 5;

// ─── TOTP secrets ────────────────────────────────────────────────────────────

/** New random base32 secret (20 bytes / 160 bits) for authenticator apps. */
export function generateTotpSecret(): string {
  return generateSecret();
}

/** otpauth:// URI for QR provisioning (scan with any RFC 6238 app). */
export function totpKeyUri(email: string, secret: string): string {
  return generateURI({ issuer: MFA_ISSUER, label: email, secret });
}

/** Verify a TOTP code against a raw base32 secret. epoch/window/digits injectable for tests. */
export async function verifyTotpCode(
  secret: string,
  code: string,
  opts: { window?: number; epoch?: number; digits?: 6 | 7 | 8 } = {},
): Promise<boolean> {
  const window = opts.window ?? 1;
  try {
    const result = await verify({
      secret,
      token: code.trim(),
      digits: opts.digits ?? 6,
      epoch: opts.epoch,
      epochTolerance: window * TOTP_PERIOD_S,
    });
    return result.valid;
  } catch (e) {
    // otplib throws on malformed tokens (e.g. a 9-char backup code like
    // "xxxx-xxxx") instead of returning {valid:false}. A malformed TOTP is
    // simply an invalid TOTP — return false so callers can fall through to
    // backup-code verification. Anything else (unexpected) still propagates.
    if (e instanceof Error && /token|digit|invalid/i.test(e.message)) return false;
    throw e;
  }
}

/** Generate the current TOTP code (test helper / symmetry with verifyTotpCode). */
export async function generateTotpCode(
  secret: string,
  opts: { digits?: 6 | 7 | 8; epoch?: number } = {},
): Promise<string> {
  return generate({ secret, digits: opts.digits ?? 6, epoch: opts.epoch });
}

// ─── At-rest encryption (AES-256-GCM) ────────────────────────────────────────

export class MfaNotConfiguredError extends Error {
  constructor() {
    super("MFA not configured on server (set MFA_ENCRYPTION_KEY or SESSION_SECRET)");
    this.name = "MfaNotConfiguredError";
  }
}

function mfaKey(): Buffer | null {
  const hex = process.env.MFA_ENCRYPTION_KEY;
  if (hex) {
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      throw new Error("MFA_ENCRYPTION_KEY must be 64 hex chars (32 bytes)");
    }
    return Buffer.from(hex, "hex");
  }
  const sessionSecret = process.env.SESSION_SECRET;
  if (sessionSecret) {
    // Derive a stable 32-byte key — domain-separated so the session secret
    // itself is never used directly as an encryption key.
    return crypto.createHash("sha256").update(`volttrade-mfa:${sessionSecret}`).digest();
  }
  return null;
}

/** True when an encryption key source is available (MFA usable on this server). */
export function mfaConfigured(): boolean {
  return mfaKey() !== null;
}

/** Encrypt a base32 TOTP secret for storage: "v1:<ivHex>:<tagHex>:<cipherHex>". */
export function encryptSecret(secret: string): string {
  const key = mfaKey();
  if (!key) throw new MfaNotConfiguredError();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return `v1:${iv.toString("hex")}:${cipher.getAuthTag().toString("hex")}:${data.toString("hex")}`;
}

/** Reverse of encryptSecret; throws on tampered/malformed ciphertext (GCM auth tag). */
export function decryptSecret(secretEnc: string): string {
  const key = mfaKey();
  if (!key) throw new MfaNotConfiguredError();
  const [v, ivHex, tagHex, dataHex] = secretEnc.split(":");
  if (v !== "v1" || !ivHex || !tagHex || !dataHex) {
    throw new Error("Malformed encrypted TOTP secret");
  }
  const decipher = crypto.createDecipheriv("aes-256-gcm", key, Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
}

/** Verify a code against the ENCRYPTED secret stored in users.totp_secret_enc. */
export async function verifyTotp(secretEnc: string, code: string, window = 1): Promise<boolean> {
  return verifyTotpCode(decryptSecret(secretEnc), code, { window });
}

// ─── Backup codes ────────────────────────────────────────────────────────────

/** Normalize user input: lowercase, keep the dash (format xxxx-xxxx). */
export function normalizeBackupCode(code: string): string {
  return code.trim().toLowerCase();
}

export function hashBackupCode(code: string): string {
  return crypto.createHash("sha256").update(normalizeBackupCode(code)).digest("hex");
}

/** 8 fresh codes in xxxx-xxxx form; store ONLY the hashes, show raw once. */
export function generateBackupCodes(): { raw: string[]; hashes: string[] } {
  const raw = Array.from({ length: BACKUP_CODE_COUNT }, () => {
    const h = crypto.randomBytes(4).toString("hex");
    return `${h.slice(0, 4)}-${h.slice(4)}`;
  });
  return { raw, hashes: raw.map(hashBackupCode) };
}

/** A 6-digit TOTP code or a backup code? TOTP first; fallback to backup. */
export function looksLikeBackupCode(code: string): boolean {
  return /^[0-9a-f]{4}-[0-9a-f]{4}$/i.test(code.trim());
}

// ─── Pending-login store (2-step login challenge) ────────────────────────────

export type MfaPendingEntry = { userId: number; createdAt: number; attempts: number };

export type MfaPendingStore = {
  /** Start a challenge after the password step succeeds. */
  create: (userId: number) => string;
  /** Valid (unexpired) entry or null; expired entries are swept. */
  peek: (token: string) => MfaPendingEntry | null;
  /** Record a failed code attempt; destroys the challenge at maxAttempts. */
  fail: (token: string) => { attempts: number; destroyed: boolean };
  /** Single-use success path: returns and removes the entry. */
  consume: (token: string) => MfaPendingEntry | null;
  size: () => number;
};

/**
 * Process-local pending store — same documented limitation as the login
 * limiter: per-replica state; move to Redis when running multi-instance.
 * `now` is injectable so TTL/attempt logic is unit-testable.
 */
export function createMfaPendingStore(
  opts: { ttlMs?: number; maxAttempts?: number; now?: () => number } = {},
): MfaPendingStore {
  const ttlMs = opts.ttlMs ?? MFA_PENDING_TTL_MS;
  const maxAttempts = opts.maxAttempts ?? MFA_PENDING_MAX_ATTEMPTS;
  const now = opts.now ?? (() => Date.now());
  const map = new Map<string, MfaPendingEntry>();

  function valid(token: string): MfaPendingEntry | null {
    const entry = map.get(token);
    if (!entry) return null;
    if (now() - entry.createdAt > ttlMs) {
      map.delete(token);
      return null;
    }
    return entry;
  }

  return {
    create(userId) {
      // Bound memory: sweep expired entries when the map grows large.
      if (map.size > 10_000) {
        for (const [k, v] of map) if (now() - v.createdAt > ttlMs) map.delete(k);
      }
      const token = crypto.randomBytes(32).toString("hex");
      map.set(token, { userId, createdAt: now(), attempts: 0 });
      return token;
    },
    peek: valid,
    fail(token) {
      const entry = valid(token);
      if (!entry) return { attempts: 0, destroyed: false };
      entry.attempts += 1;
      if (entry.attempts >= maxAttempts) {
        map.delete(token); // challenge destroyed — user must log in again
        return { attempts: entry.attempts, destroyed: true };
      }
      return { attempts: entry.attempts, destroyed: false };
    },
    consume(token) {
      const entry = valid(token);
      if (!entry) return null;
      map.delete(token);
      return entry;
    },
    size: () => map.size,
  };
}

/** Shared store used by the auth router. */
export const mfaPending = createMfaPendingStore();
