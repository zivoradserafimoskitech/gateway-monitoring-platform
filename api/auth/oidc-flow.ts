// §9.12: the OIDC flow's impure half — discovery, the token exchange and the
// session it ends in. Every decision about whether a token is TRUSTED lives in
// ./oidc.ts and is unit-tested; this file does the network and the database.
import { and, eq, gte, lt } from "drizzle-orm";
import { getDb } from "../queries/connection";
import { oidcLogins, oidcProviders, orgMemberships, users } from "@db/schema";
import { createSession, hashPassword } from "../lib/auth";
import { decryptSecret } from "../lib/totp";
import { assertEgressAllowed } from "../lib/egress";
import {
  buildAuthUrl,
  decideLogin,
  mayLinkAccount,
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

  // One row, looked up by email the way password login does it (stored and
  // compared lower-case) — not a scan of every user in the installation.
  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
  const found = email
    ? await db
        .select({
          id: users.id,
          email: users.email,
          disabled: users.disabled,
          isSuperadmin: users.isSuperadmin,
          orgId: users.orgId,
        })
        .from(users)
        .where(eq(users.email, email))
        .limit(1)
    : [];
  const existing = found[0];
  const providerOrgId = provider.orgId ?? null;

  const decision = decideLogin(
    claims,
    {
      allowedDomains: parseDomains(provider.allowedDomains),
      autoProvision: provider.autoProvision,
      defaultRole: provider.defaultRole,
      providerOrgId,
    },
    new Set(existing ? [existing.email.toLowerCase()] : []),
  );
  if (decision.kind === "reject") throw new OidcError(decision.reason);

  let userId: number;
  if (decision.kind === "link") {
    if (!existing) throw new OidcError("account disappeared mid-login");
    // The tenant boundary. A provider is whatever its org's admin configured,
    // so it can mint any verified email it likes — its word is only good for
    // accounts in its own org, and never for a superadmin. See mayLinkAccount.
    const memberships = await db
      .select({ orgId: orgMemberships.orgId })
      .from(orgMemberships)
      .where(eq(orgMemberships.userId, existing.id));
    const gate = mayLinkAccount(providerOrgId, {
      // Truthy, not === true: the same rule as isSuper, since a raw driver
      // hands a MySQL boolean back as 1. Erring here would let an org's IdP in.
      isSuperadmin: Boolean(existing.isSuperadmin),
      disabled: existing.disabled !== 0,
      orgIds: [existing.orgId, ...memberships.map((m) => m.orgId)].filter((o): o is number => o !== null),
    });
    if (!gate.ok) throw new OidcError(gate.reason);
    userId = existing.id;
  } else {
    // decideLogin refuses provisioning through a global provider, so the org
    // is known here; the check is what lets the type say so.
    if (providerOrgId === null) throw new OidcError("a global provider cannot create accounts");
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
        orgId: providerOrgId,
      })
      .$returningId();
    userId = inserted[0].id;
    // §9.11: an account exists in an org through a membership row. Without it
    // the account works but the org switcher shows it belonging to nothing.
    await db
      .insert(orgMemberships)
      .values({ userId, orgId: providerOrgId, role: decision.role })
      .onDuplicateKeyUpdate({ set: { role: decision.role } });
  }

  const session = await createSession(userId);
  return {
    sessionToken: session.token,
    expiresAt: session.expiresAt,
    redirectTo: safeRedirect(login.redirectTo),
    email: decision.email,
  };
}
