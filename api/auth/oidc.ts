// §9.12: OIDC single sign-on — the pure half.
//
// This is a procurement blocker rather than a feature: industrial customers
// hand over a list of their SSO requirements before they will discuss anything
// else, and "we have our own login form" ends the conversation.
//
// It is also the one item on the §9 list that cannot be proved end to end in
// CI, because there is no identity provider on a runner. What IS proved there
// is everything that decides whether a token is trusted: the tests generate
// their own RSA and EC keys, sign tokens with them, and assert that each
// tampering is rejected. The untested part is the network round trip to a real
// IdP, which is why the whole feature ships behind a per-provider flag and
// password login is never removed.
//
// Authorization Code with PKCE. No implicit flow, no hybrid: an id_token
// arriving in a redirect fragment is a token in a URL, and this codebase has
// already decided (twice — export links, webhook signatures) what it thinks of
// credentials in URLs.
import crypto from "node:crypto";

export class OidcError extends Error {}

// ─── PKCE and one-time values ────────────────────────────────────────────────
export interface Pkce {
  verifier: string;
  challenge: string;
  method: "S256";
}

/**
 * PKCE pair. S256 only — the "plain" method puts the verifier in the
 * authorization request, which defeats the point of having one.
 */
export function pkcePair(): Pkce {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge, method: "S256" };
}

export function randomToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export interface ProviderConfig {
  issuer: string;
  clientId: string;
  authorizationEndpoint: string;
  scopes: string;
}

/** The authorization request. state, nonce and PKCE are all mandatory. */
export function buildAuthUrl(
  provider: ProviderConfig,
  redirectUri: string,
  state: string,
  nonce: string,
  pkce: Pkce,
): string {
  const u = new URL(provider.authorizationEndpoint);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", provider.clientId);
  u.searchParams.set("redirect_uri", redirectUri);
  u.searchParams.set("scope", provider.scopes || "openid email profile");
  u.searchParams.set("state", state);
  u.searchParams.set("nonce", nonce);
  u.searchParams.set("code_challenge", pkce.challenge);
  u.searchParams.set("code_challenge_method", pkce.method);
  return u.toString();
}

// ─── id_token verification ───────────────────────────────────────────────────
export interface Jwk {
  kty: string;
  kid?: string;
  alg?: string;
  use?: string;
  n?: string;
  e?: string;
  crv?: string;
  x?: string;
  y?: string;
}

export interface IdTokenClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  [k: string]: unknown;
}

/**
 * Algorithms this accepts, and nothing else.
 *
 * "none" is obviously excluded. HS256 is excluded too, and that is the less
 * obvious half: an HMAC id_token is verified with the CLIENT SECRET, so a
 * verifier that accepts both asymmetric and symmetric algorithms can be handed
 * a token signed with a secret the attacker already knows — the classic
 * algorithm-confusion break. Only signatures made with a key published in the
 * IdP's JWKS are accepted here.
 */
const ALLOWED_ALGS = new Set(["RS256", "RS384", "RS512", "ES256", "ES384"]);

/** Seconds of clock skew tolerated on exp/iat. */
export const CLOCK_SKEW_S = 60;

function b64urlJson(part: string): Record<string, unknown> {
  const json = Buffer.from(part, "base64url").toString("utf8");
  const parsed: unknown = JSON.parse(json);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new OidcError("malformed JWT segment");
  return parsed as Record<string, unknown>;
}

/**
 * The kid an id_token's header names — read WITHOUT verifying anything, and
 * only ever used to decide whether the cached key set is stale. Null for a
 * header that names no key or cannot be read; verifyIdToken rejects those.
 */
export function idTokenKid(token: string): string | null {
  try {
    const header = b64urlJson(token.split(".")[0] ?? "");
    return typeof header.kid === "string" ? header.kid : null;
  } catch {
    return null;
  }
}

/** Does this key set hold a key verifyIdToken could pick for `kid`? The same
 *  matching rule it uses: by kid when the token names one, else keyless keys. */
export function jwksCovers(jwks: Jwk[], kid: string | null): boolean {
  return kid ? jwks.some((k) => k.kid === kid) : jwks.some((k) => !k.kid);
}

function keyFromJwk(jwk: Jwk): crypto.KeyObject {
  try {
    return crypto.createPublicKey({ key: jwk as crypto.JsonWebKey, format: "jwk" });
  } catch {
    throw new OidcError("unusable signing key in JWKS");
  }
}

function nodeAlg(alg: string): { hash: string; dsaEncoding?: "der" | "ieee-p1363" } {
  if (alg.startsWith("ES")) return { hash: `sha${alg.slice(2)}`, dsaEncoding: "ieee-p1363" };
  return { hash: `sha${alg.slice(2)}` };
}

export interface VerifyOptions {
  issuer: string;
  clientId: string;
  nonce: string;
  jwks: Jwk[];
  nowSec?: number;
  skewSec?: number;
}

/**
 * Verify an id_token and return its claims.
 *
 * Order matters: the signature is checked before anything is believed, and the
 * header's `kid` must name a key the IdP actually published. Everything after
 * that is a claim check, each of which has a specific attack behind it —
 * see the comments.
 */
export function verifyIdToken(token: string, opts: VerifyOptions): IdTokenClaims {
  const parts = token.split(".");
  if (parts.length !== 3) throw new OidcError("id_token is not a three-part JWT");
  const [headerB64, payloadB64, sigB64] = parts;

  const header = b64urlJson(headerB64);
  const alg = typeof header.alg === "string" ? header.alg : "";
  if (!ALLOWED_ALGS.has(alg)) throw new OidcError(`unsupported id_token algorithm: ${alg || "(none)"}`);

  // A token whose header names no key, or names one the IdP never published,
  // is not verifiable — picking "the only RSA key" instead would accept a
  // token signed by any key that happened to be in the set.
  const kid = typeof header.kid === "string" ? header.kid : null;
  const candidates = kid ? opts.jwks.filter((k) => k.kid === kid) : opts.jwks.filter((k) => !k.kid);
  if (candidates.length === 0) throw new OidcError("no JWKS key matches the id_token's kid");

  const { hash, dsaEncoding } = nodeAlg(alg);
  const signed = Buffer.from(`${headerB64}.${payloadB64}`, "utf8");
  const signature = Buffer.from(sigB64, "base64url");
  const ok = candidates.some((jwk) => {
    try {
      const verifier = crypto.createVerify(hash);
      verifier.update(signed);
      return verifier.verify({ key: keyFromJwk(jwk), ...(dsaEncoding ? { dsaEncoding } : {}) }, signature);
    } catch {
      return false;
    }
  });
  if (!ok) throw new OidcError("id_token signature does not verify");

  const claims = b64urlJson(payloadB64) as unknown as IdTokenClaims;
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const skew = opts.skewSec ?? CLOCK_SKEW_S;

  // Exact match, not a prefix or a suffix: "https://evil.example/.well-known"
  // ends with nothing useful, but a careless startsWith would let
  // "https://issuer.example.evil.com" through.
  if (claims.iss !== opts.issuer) throw new OidcError("id_token issuer does not match the configured provider");

  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(opts.clientId)) throw new OidcError("id_token audience does not include this client");

  if (typeof claims.exp !== "number" || claims.exp + skew < now) throw new OidcError("id_token has expired");
  if (typeof claims.iat !== "number" || claims.iat - skew > now) throw new OidcError("id_token is issued in the future");

  // The nonce binds this token to THIS login attempt. Without it a token
  // captured from another session — or replayed from a previous one — is
  // indistinguishable from a fresh login.
  if (!claims.nonce || claims.nonce !== opts.nonce) throw new OidcError("id_token nonce does not match this login");

  if (typeof claims.sub !== "string" || claims.sub.length === 0) throw new OidcError("id_token has no subject");
  return claims;
}

// ─── Mapping a verified token to an account ──────────────────────────────────
export interface ProvisionPolicy {
  /** Domains allowed to sign in, lower-cased, without the @. Empty = none. */
  allowedDomains: string[];
  /** Whether an unknown email may create an account. */
  autoProvision: boolean;
  /** Role given to an account created this way. */
  defaultRole: "admin" | "operator" | "viewer";
  /** The org the provider belongs to; null for a global (superadmin) provider. */
  providerOrgId: number | null;
}

export type LoginDecision =
  | { kind: "link"; email: string; name: string | null }
  | { kind: "provision"; email: string; name: string | null; role: "admin" | "operator" | "viewer" }
  | { kind: "reject"; reason: string };

export function emailDomain(email: string): string | null {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}

/**
 * What to do with a verified token.
 *
 * Three refusals worth naming:
 *
 *  - No email, or an UNVERIFIED one. Accounts here are keyed by email, so
 *    accepting an unverified address means anyone who can register one at the
 *    IdP can claim the matching account.
 *  - A domain not on the list. An empty list with auto-provisioning on is
 *    refused rather than treated as "any domain": a public IdP would otherwise
 *    hand an account to the entire internet.
 *  - An unknown email when auto-provisioning is off. Sign-in is not the same
 *    permission as account creation.
 *
 * The role NEVER comes from the token. Mapping IdP groups to admin depends on
 * the customer's group hygiene being perfect, and the failure mode is somebody
 * granting themselves administration of a system that controls plant. Admin
 * stays a local decision.
 */
export function decideLogin(
  claims: IdTokenClaims,
  policy: ProvisionPolicy,
  knownEmails: Set<string>,
): LoginDecision {
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  if (!email) return { kind: "reject", reason: "the identity provider returned no email address" };
  if (claims.email_verified !== true) {
    return { kind: "reject", reason: "the identity provider has not verified this email address" };
  }
  const domain = emailDomain(email);
  if (!domain) return { kind: "reject", reason: "the email address is malformed" };

  const name = typeof claims.name === "string" && claims.name.trim() ? claims.name.trim() : null;

  if (knownEmails.has(email)) {
    // An existing account: domain rules still apply, so revoking a domain
    // locks out its users rather than only stopping new ones.
    if (policy.allowedDomains.length > 0 && !policy.allowedDomains.includes(domain)) {
      return { kind: "reject", reason: `${domain} is not an allowed domain for this provider` };
    }
    return { kind: "link", email, name };
  }

  if (!policy.autoProvision) {
    return { kind: "reject", reason: "no account exists for this address and automatic provisioning is off" };
  }
  // A global provider has no org to put a new account in, and an account with
  // no tenant is not a state anything downstream expects.
  if (policy.providerOrgId === null) {
    return { kind: "reject", reason: "a global provider cannot create accounts; it has no organization to put them in" };
  }
  if (policy.allowedDomains.length === 0) {
    return {
      kind: "reject",
      reason: "automatic provisioning needs an allowed-domain list — an empty list would admit any address",
    };
  }
  if (!policy.allowedDomains.includes(domain)) {
    return { kind: "reject", reason: `${domain} is not an allowed domain for this provider` };
  }
  return { kind: "provision", email, name, role: policy.defaultRole };
}

/** Parse a stored domain list: comma or whitespace separated, @ optional. */
export function parseDomains(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[\s,]+/) : [];
  return [...new Set(list.map((d) => String(d).trim().replace(/^@/, "").toLowerCase()).filter(Boolean))];
}

// ─── Who a provider may vouch for ────────────────────────────────────────────
export interface LinkTarget {
  isSuperadmin: boolean;
  disabled: boolean;
  /** Every org the account can act under: its home org plus its memberships. */
  orgIds: number[];
}

export type LinkGate = { ok: true } | { ok: false; reason: string };

/**
 * May this provider sign this EXISTING account in?
 *
 * The rule that keeps one tenant out of another. An identity provider is
 * something its org's admin controls end to end — they choose the issuer, and
 * through it they can mint any claim they like, including someone else's
 * verified email. Every signature check passes on such a token, because it
 * really is that provider's token. So the provider's word is only good for
 * accounts that belong to its own org:
 *
 *  - an org-scoped provider may link an account only if the account is a
 *    member of that org;
 *  - it may NEVER link a superadmin. The platform account is not any single
 *    tenant's to vouch for, and it is the most valuable account to steal;
 *  - a global provider (no org) can only be configured by a superadmin, so it
 *    may link any account.
 *
 * Without this, any org admin could configure a provider pointed at an IdP
 * they control and sign in as anyone in the installation.
 */
export function mayLinkAccount(providerOrgId: number | null, target: LinkTarget): LinkGate {
  // Checked first: SSO proves who somebody is, it is not a way around having
  // been switched off.
  if (target.disabled) return { ok: false, reason: "this account is disabled" };
  if (providerOrgId === null) return { ok: true };
  if (target.isSuperadmin) {
    return { ok: false, reason: "an organization's provider cannot sign in a platform administrator" };
  }
  if (!target.orgIds.includes(providerOrgId)) {
    return { ok: false, reason: "this account does not belong to the provider's organization" };
  }
  return { ok: true };
}
