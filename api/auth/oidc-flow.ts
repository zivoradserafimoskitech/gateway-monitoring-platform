// §9.12: the OIDC flow's impure half — discovery, the token exchange and the
// session it ends in. Every decision about whether a token is TRUSTED lives in
// ./oidc.ts and is unit-tested; this file does the network and the database.
import { and, eq, gte, lt } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { oidcLogins, oidcProviders, users } from "@db/schema";
import { createSession, hashPassword } from "../lib/auth";
import { decryptSecret } from "../lib/totp";
import { assertEgressAllowed } from "../lib/egress";
import {
  buildAuthUrl,
  decideLogin,
  OidcError,
  parseDomains,
  pkcePair,
  randomToken,
  verifyIdToken,
  type Jwk,
} from "./oidc";
import crypto from "node:crypto";

const FETCH_TIMEOUT_MS = 8000;
/** How long a started login may take to come back. */
const LOGIN_TTL_MS = 10 * 60_000;

/** JWKS cache. Key rotation at the IdP must be picked up without a restart, so
 *  this is short — and a cache miss costs one request on a path a human is
 *  already waiting on anyway. */
const jwksCache = new Map<string, { at: number; keys: Jwk[] }>();
const JWKS_TTL_MS = 5 * 60_000;

export function invalidateJwksCache(): void {
  jwksCache.clear();
}

async function fetchJwks(uri: string): Promise<Jwk[]> {
  const hit = jwksCache.get(uri);
  if (hit && Date.now() - hit.at < JWKS_TTL_MS) return hit.keys;
  // The same SSRF guard as every other outbound target: an IdP URL is
  // configuration, and configuration gets edited.
  await assertEgressAllowed(uri);
  const res = await fetch(uri, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new OidcError(`JWKS fetch failed: HTTP ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  if (!Array.isArray(body.keys) || body.keys.length === 0) throw new OidcError("JWKS contains no keys");
  jwksCache.set(uri, { at: Date.now(), keys: body.keys });
  return body.keys;
}

/**
 * Where the browser may be sent after a successful login.
 *
 * Local paths only. An open redirect on a login callback is how a phishing
 * page borrows somebody else's domain, and "//evil.example" is a protocol
 * relative URL that a naive startsWith("/") test waves through.
 */
export function safeRedirect(raw: string | null | undefined): string {
  if (!raw) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  if (raw.includes("\\")) return "/";
  return raw;
}

export async function startLogin(
  providerId: number,
  redirectUri: string,
  redirectTo: string | null,
): Promise<string> {
  const db = getDb();
  const rows = await db
    .select()
    .from(oidcProviders)
    .where(and(eq(oidcProviders.id, providerId), eq(oidcProviders.enabled, true)))
    .limit(1);
  const provider = rows[0];
  if (!provider) throw new OidcError("no such single sign-on provider");

  const state = randomToken();
  const nonce = randomToken();
  const pkce = pkcePair();
  await db.insert(oidcLogins).values({
    state,
    providerId,
    nonce,
    codeVerifier: pkce.verifier,
    redirectTo: safeRedirect(redirectTo),
    expiresAt: new Date(Date.now() + LOGIN_TTL_MS),
  });
  // Opportunistic cleanup: expired rows are useless and this is the only path
  // that creates them.
  await db.delete(oidcLogins).where(lt(oidcLogins.expiresAt, new Date()));

  return buildAuthUrl(
    {
      issuer: provider.issuer,
      clientId: provider.clientId,
      authorizationEndpoint: provider.authorizationEndpoint,
      scopes: provider.scopes,
    },
    redirectUri,
    state,
    nonce,
    pkce,
  );
}

export interface CallbackResult {
  sessionToken: string;
  expiresAt: Date;
  redirectTo: string;
  email: string;
}

export async function completeLogin(
  state: string,
  code: string,
  redirectUri: string,
): Promise<CallbackResult> {
  const db = getDb();
  const loginRows = await db
    .select()
    .from(oidcLogins)
    .where(and(eq(oidcLogins.state, state), gte(oidcLogins.expiresAt, new Date())))
    .limit(1);
  const login = loginRows[0];
  if (!login) throw new OidcError("this sign-in attempt has expired or was already used");
  // Single use, deleted before the exchange: a replayed callback must not get
  // a second chance at the same state.
  await db.delete(oidcLogins).where(eq(oidcLogins.state, state));

  const providerRows = await db
    .select()
    .from(oidcProviders)
    .where(and(eq(oidcProviders.id, login.providerId), eq(oidcProviders.enabled, true)))
    .limit(1);
  const provider = providerRows[0];
  if (!provider) throw new OidcError("this provider is no longer enabled");

  await assertEgressAllowed(provider.tokenEndpoint);
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: provider.clientId,
    code_verifier: login.codeVerifier,
  });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
  if (provider.clientSecretEnc) {
    // Basic auth rather than a body parameter: client_secret_basic is what
    // most IdPs expect, and it keeps the secret out of anything that logs
    // request bodies.
    const secret = decryptSecret(provider.clientSecretEnc);
    headers.authorization = `Basic ${Buffer.from(`${provider.clientId}:${secret}`).toString("base64")}`;
  }
  const res = await fetch(provider.tokenEndpoint, {
    method: "POST",
    headers,
    body,
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new OidcError(`token exchange failed: HTTP ${res.status}`);
  const tokens = (await res.json()) as { id_token?: string };
  if (!tokens.id_token) throw new OidcError("the identity provider returned no id_token");

  const jwks = await fetchJwks(provider.jwksUri);
  const claims = verifyIdToken(tokens.id_token, {
    issuer: provider.issuer,
    clientId: provider.clientId,
    nonce: login.nonce,
    jwks,
  });

  const known = await db.select({ email: users.email, id: users.id, disabled: users.disabled }).from(users);
  const decision = decideLogin(
    claims,
    {
      allowedDomains: parseDomains(provider.allowedDomains),
      autoProvision: provider.autoProvision,
      defaultRole: provider.defaultRole,
    },
    new Set(known.map((u) => u.email.toLowerCase())),
  );
  if (decision.kind === "reject") throw new OidcError(decision.reason);

  let userId: number;
  if (decision.kind === "link") {
    const existing = known.find((u) => u.email.toLowerCase() === decision.email);
    if (!existing) throw new OidcError("account disappeared mid-login");
    // A disabled account stays disabled: SSO is a way to prove who you are,
    // not a way around having been switched off.
    if (existing.disabled !== 0) throw new OidcError("this account is disabled");
    userId = existing.id;
  } else {
    const inserted = await db
      .insert(users)
      .values({
        email: decision.email,
        name: decision.name ?? decision.email,
        // A random, discarded password. The column is NOT NULL and the account
        // is meant to sign in through the IdP; leaving a known or empty value
        // here would create a password-login hole beside the SSO one.
        passwordHash: hashPassword(crypto.randomBytes(32).toString("base64url")),
        role: decision.role,
        orgId: provider.orgId ?? null,
      })
      .$returningId();
    userId = inserted[0].id;
  }

  const session = await createSession(userId);
  return {
    sessionToken: session.token,
    expiresAt: session.expiresAt,
    redirectTo: safeRedirect(login.redirectTo),
    email: decision.kind === "reject" ? "" : decision.email,
  };
}
