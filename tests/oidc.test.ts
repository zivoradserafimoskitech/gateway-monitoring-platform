// §9.12: OIDC. This is the one §9 item that cannot be proved end to end in CI
// — there is no identity provider on a runner — so these tests do the next
// best thing and cover everything that decides whether a token is TRUSTED.
// They generate their own keys, sign their own tokens, and assert that each
// tampering is refused.
import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import {
  buildAuthUrl,
  decideLogin,
  idTokenKid,
  jwksCovers,
  mayLinkAccount,
  emailDomain,
  parseDomains,
  pkcePair,
  verifyIdToken,
  type IdTokenClaims,
  type Jwk,
} from "../api/auth/oidc";
import { safeRedirect } from "../api/auth/oidc-flow";

const ISSUER = "https://idp.example.com";
const CLIENT_ID = "volttrade-test";
const NONCE = "nonce-abc";
const NOW = 1_800_000_000;

const rsa = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
const rsaJwk = { ...(rsa.publicKey.export({ format: "jwk" }) as Jwk), kid: "rsa-1", alg: "RS256" };
const ec = crypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const ecJwk = { ...(ec.publicKey.export({ format: "jwk" }) as Jwk), kid: "ec-1", alg: "ES256" };
const other = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });

const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

function sign(
  payload: Partial<IdTokenClaims>,
  opts: { alg?: string; kid?: string | null; key?: crypto.KeyObject } = {},
): string {
  const alg = opts.alg ?? "RS256";
  const header: Record<string, unknown> = { alg, typ: "JWT" };
  if (opts.kid !== null) header.kid = opts.kid ?? (alg.startsWith("ES") ? "ec-1" : "rsa-1");
  const claims: IdTokenClaims = {
    iss: ISSUER,
    sub: "user-1",
    aud: CLIENT_ID,
    exp: NOW + 300,
    iat: NOW - 5,
    nonce: NONCE,
    email: "person@customer.example",
    email_verified: true,
    name: "A Person",
    ...payload,
  };
  const signed = `${b64(header)}.${b64(claims)}`;
  if (alg === "none") return `${signed}.`;
  if (alg === "HS256") {
    const mac = crypto.createHmac("sha256", "client-secret").update(signed).digest("base64url");
    return `${signed}.${mac}`;
  }
  const key = opts.key ?? (alg.startsWith("ES") ? ec.privateKey : rsa.privateKey);
  const hash = `sha${alg.slice(2)}`;
  const signer = crypto.createSign(hash);
  signer.update(signed);
  const sig = signer.sign(alg.startsWith("ES") ? { key, dsaEncoding: "ieee-p1363" } : key);
  return `${signed}.${sig.toString("base64url")}`;
}

const verify = (token: string, over: Partial<Parameters<typeof verifyIdToken>[1]> = {}) =>
  verifyIdToken(token, {
    issuer: ISSUER,
    clientId: CLIENT_ID,
    nonce: NONCE,
    jwks: [rsaJwk, ecJwk],
    nowSec: NOW,
    ...over,
  });

describe("pkcePair", () => {
  it("is S256, and the challenge is the hash of the verifier", () => {
    const p = pkcePair();
    expect(p.method).toBe("S256");
    expect(crypto.createHash("sha256").update(p.verifier).digest("base64url")).toBe(p.challenge);
  });

  it("is different every time", () => {
    expect(pkcePair().verifier).not.toBe(pkcePair().verifier);
  });
});

describe("buildAuthUrl", () => {
  const provider = {
    issuer: ISSUER,
    clientId: CLIENT_ID,
    authorizationEndpoint: `${ISSUER}/authorize`,
    scopes: "openid email",
  };

  it("sends code flow with state, nonce and PKCE — never implicit", () => {
    const p = pkcePair();
    const u = new URL(buildAuthUrl(provider, "https://app.example/cb", "st", "no", p));
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("state")).toBe("st");
    expect(u.searchParams.get("nonce")).toBe("no");
    expect(u.searchParams.get("code_challenge")).toBe(p.challenge);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    // An id_token in a redirect fragment is a credential in a URL.
    expect(u.searchParams.get("response_type")).not.toContain("token");
  });

  it("keeps the endpoint's own query parameters", () => {
    const u = new URL(
      buildAuthUrl({ ...provider, authorizationEndpoint: `${ISSUER}/authorize?tenant=acme` }, "https://a/cb", "s", "n", pkcePair()),
    );
    expect(u.searchParams.get("tenant")).toBe("acme");
  });
});

describe("verifyIdToken", () => {
  it("accepts a correctly signed RS256 token", () => {
    expect(verify(sign({})).sub).toBe("user-1");
  });

  it("accepts ES256 as well", () => {
    expect(verify(sign({}, { alg: "ES256" })).sub).toBe("user-1");
  });

  it("rejects alg=none", () => {
    expect(() => verify(sign({}, { alg: "none" }))).toThrow(/unsupported id_token algorithm/);
  });

  it("rejects HS256 — the algorithm-confusion break", () => {
    // An HMAC id_token verifies with the CLIENT SECRET. A verifier that takes
    // both kinds can be handed a token signed with a secret the attacker
    // already has.
    expect(() => verify(sign({}, { alg: "HS256" }))).toThrow(/unsupported id_token algorithm/);
  });

  it("rejects a token signed by a key the IdP never published", () => {
    expect(() => verify(sign({}, { key: other.privateKey }))).toThrow(/signature does not verify/);
  });

  it("rejects a token whose kid names no published key", () => {
    expect(() => verify(sign({}, { kid: "rotated-away" }))).toThrow(/no JWKS key matches/);
  });

  it("does not fall back to 'the only key' when the kid is absent", () => {
    // Accepting it would mean any key in the set could sign for any other.
    expect(() => verify(sign({}, { kid: null }))).toThrow(/no JWKS key matches/);
  });

  it("rejects a tampered payload", () => {
    const token = sign({});
    const [h, , s] = token.split(".");
    const forged = `${h}.${b64({ iss: ISSUER, sub: "admin", aud: CLIENT_ID, exp: NOW + 300, iat: NOW, nonce: NONCE })}.${s}`;
    expect(() => verify(forged)).toThrow(/signature does not verify/);
  });

  it("rejects a foreign issuer, including a lookalike", () => {
    expect(() => verify(sign({ iss: "https://evil.example" }))).toThrow(/issuer does not match/);
    // The case a startsWith test would wave through.
    expect(() => verify(sign({ iss: `${ISSUER}.evil.com` }))).toThrow(/issuer does not match/);
  });

  it("rejects a token minted for another client", () => {
    expect(() => verify(sign({ aud: "someone-else" }))).toThrow(/audience does not include/);
  });

  it("accepts an audience array that contains this client", () => {
    expect(verify(sign({ aud: ["other", CLIENT_ID] })).sub).toBe("user-1");
  });

  it("rejects an expired token, with a small skew allowance", () => {
    expect(() => verify(sign({ exp: NOW - 120 }))).toThrow(/expired/);
    expect(verify(sign({ exp: NOW - 30 })).sub).toBe("user-1"); // inside the 60s skew
  });

  it("rejects a token issued in the future", () => {
    expect(() => verify(sign({ iat: NOW + 600 }))).toThrow(/issued in the future/);
  });

  it("rejects a mismatched or missing nonce", () => {
    // The nonce binds the token to THIS login attempt; without it a captured
    // token is indistinguishable from a fresh sign-in.
    expect(() => verify(sign({ nonce: "someone-elses" }))).toThrow(/nonce does not match/);
    expect(() => verify(sign({ nonce: undefined }))).toThrow(/nonce does not match/);
  });

  it("rejects a token with no subject", () => {
    expect(() => verify(sign({ sub: "" }))).toThrow(/no subject/);
  });

  it("rejects malformed input without throwing something unhelpful", () => {
    for (const bad of ["", "a.b", "a.b.c.d", "not-a-jwt"]) {
      expect(() => verify(bad)).toThrow();
    }
  });
});

describe("decideLogin", () => {
  const claims = (over: Partial<IdTokenClaims> = {}): IdTokenClaims => ({
    iss: ISSUER,
    sub: "s",
    aud: CLIENT_ID,
    exp: NOW,
    iat: NOW,
    email: "person@customer.example",
    email_verified: true,
    name: "A Person",
    ...over,
  });
  const policy = {
    allowedDomains: ["customer.example"],
    autoProvision: true,
    defaultRole: "viewer" as const,
    providerOrgId: 7 as number | null,
  };

  it("links an existing account", () => {
    const d = decideLogin(claims(), policy, new Set(["person@customer.example"]));
    expect(d).toEqual({ kind: "link", email: "person@customer.example", name: "A Person" });
  });

  it("provisions an allowed new address", () => {
    const d = decideLogin(claims(), policy, new Set());
    expect(d).toEqual({ kind: "provision", email: "person@customer.example", name: "A Person", role: "viewer" });
  });

  it("refuses an unverified email", () => {
    // Accounts are keyed by email, so an unverified address means anyone who
    // can register one at the IdP can claim the matching account.
    const d = decideLogin(claims({ email_verified: false }), policy, new Set());
    expect(d).toEqual({ kind: "reject", reason: expect.stringContaining("not verified") });
  });

  it("refuses a token with no email at all", () => {
    expect(decideLogin(claims({ email: undefined }), policy, new Set()).kind).toBe("reject");
  });

  it("refuses a domain that is not on the list", () => {
    const d = decideLogin(claims({ email: "person@other.example" }), policy, new Set());
    expect(d.kind).toBe("reject");
  });

  it("applies the domain rule to EXISTING accounts too", () => {
    // Revoking a domain should lock its users out, not merely stop new ones.
    const d = decideLogin(claims({ email: "person@other.example" }), policy, new Set(["person@other.example"]));
    expect(d.kind).toBe("reject");
  });

  it("refuses auto-provisioning with an empty domain list", () => {
    // Against a public IdP, "no list" read as "any domain" hands an account to
    // the entire internet.
    const d = decideLogin(claims(), { ...policy, allowedDomains: [] }, new Set());
    expect(d).toEqual({ kind: "reject", reason: expect.stringContaining("allowed-domain list") });
  });

  it("refuses an unknown address when provisioning is off", () => {
    const d = decideLogin(claims(), { ...policy, autoProvision: false }, new Set());
    expect(d.kind).toBe("reject");
  });

  it("never takes the role from the token", () => {
    // Group-to-admin mapping depends on the customer's group hygiene being
    // perfect, and the failure mode is self-granted administration of a system
    // that controls plant.
    const d = decideLogin(
      claims({ role: "admin", roles: ["admin"], groups: ["superadmin"] }),
      policy,
      new Set(),
    );
    expect(d).toEqual({ kind: "provision", email: "person@customer.example", name: "A Person", role: "viewer" });
  });

  it("refuses to provision through a global provider", () => {
    // A global provider has no org to put the account in.
    const d = decideLogin(claims(), { ...policy, providerOrgId: null }, new Set());
    expect(d).toEqual({ kind: "reject", reason: expect.stringContaining("global provider") });
  });

  it("matches email case-insensitively", () => {
    const d = decideLogin(claims({ email: "Person@Customer.Example" }), policy, new Set(["person@customer.example"]));
    expect(d.kind).toBe("link");
  });
});

describe("parseDomains and emailDomain", () => {
  it("normalises a mixed list", () => {
    expect(parseDomains("@a.com, B.COM  c.com")).toEqual(["a.com", "b.com", "c.com"]);
    expect(parseDomains(["@x.io", "x.io"])).toEqual(["x.io"]);
    expect(parseDomains(null)).toEqual([]);
  });

  it("takes the last @ so a quoted local part cannot smuggle a domain", () => {
    expect(emailDomain("a@b@real.example")).toBe("real.example");
    expect(emailDomain("nodomain")).toBeNull();
    expect(emailDomain("@leading")).toBeNull();
    expect(emailDomain("trailing@")).toBeNull();
  });
});

describe("safeRedirect", () => {
  it("allows a local path", () => {
    expect(safeRedirect("/alarms")).toBe("/alarms");
  });

  it("refuses an absolute URL, a protocol-relative one, and a backslash trick", () => {
    // An open redirect on a login callback is how a phishing page borrows
    // somebody else's domain. "//evil.example" is the one a naive
    // startsWith("/") test waves through.
    expect(safeRedirect("https://evil.example")).toBe("/");
    expect(safeRedirect("//evil.example")).toBe("/");
    expect(safeRedirect("/\\evil.example")).toBe("/");
    expect(safeRedirect(null)).toBe("/");
    expect(safeRedirect("")).toBe("/");
  });
});

describe("mayLinkAccount — the tenant boundary", () => {
  // The attack this exists for: an org admin configures a provider pointed at
  // an IdP they control and mints a token carrying someone else's verified
  // email. Every signature, issuer, audience and nonce check PASSES on that
  // token, because it really is that provider's token. This gate is the only
  // thing standing between one tenant and every other account.
  const member = { isSuperadmin: false, disabled: false, orgIds: [7] };

  it("links an account that belongs to the provider's org", () => {
    expect(mayLinkAccount(7, member)).toEqual({ ok: true });
  });

  it("links through a membership, not only the home org", () => {
    // A contractor whose home org is 3 but who is also a member of 7.
    expect(mayLinkAccount(7, { ...member, orgIds: [3, 7] })).toEqual({ ok: true });
  });

  it("refuses an account from another organization", () => {
    const r = mayLinkAccount(7, { ...member, orgIds: [3] });
    expect(r.ok).toBe(false);
  });

  it("refuses an account that belongs to no organization", () => {
    expect(mayLinkAccount(7, { ...member, orgIds: [] }).ok).toBe(false);
  });

  it("never lets an org's provider sign in a superadmin — even one who is a member", () => {
    // The platform account is not any single tenant's to vouch for, and it is
    // the most valuable account in the system to take.
    const r = mayLinkAccount(7, { isSuperadmin: true, disabled: false, orgIds: [7] });
    expect(r).toEqual({ ok: false, reason: expect.stringContaining("platform administrator") });
  });

  it("lets a global provider link any account, including a superadmin", () => {
    // Only a superadmin can configure one (ssoProviderSave enforces it).
    expect(mayLinkAccount(null, { isSuperadmin: true, disabled: false, orgIds: [] })).toEqual({ ok: true });
    expect(mayLinkAccount(null, { ...member, orgIds: [3] })).toEqual({ ok: true });
  });

  it("refuses a disabled account whatever the provider", () => {
    expect(mayLinkAccount(7, { ...member, disabled: true }).ok).toBe(false);
    expect(mayLinkAccount(null, { ...member, disabled: true }).ok).toBe(false);
  });
});

describe("JWKS rotation helpers", () => {
  const jwt = (header: object) => `${Buffer.from(JSON.stringify(header)).toString("base64url")}.e30.sig`;

  it("reads the kid an id_token names, without verifying it", () => {
    expect(idTokenKid(jwt({ alg: "RS256", kid: "2026-10" }))).toBe("2026-10");
    expect(idTokenKid(jwt({ alg: "RS256" }))).toBeNull();
  });

  it("returns null for a header it cannot read rather than throwing", () => {
    expect(idTokenKid("not-a-jwt")).toBeNull();
    expect(idTokenKid("")).toBeNull();
  });

  it("knows whether the cached set can verify the token at all", () => {
    // A kid the set does not hold is the signal to refetch once: the IdP has
    // rotated and the cache predates the new key.
    const set = [{ kty: "RSA", kid: "old" }];
    expect(jwksCovers(set, "old")).toBe(true);
    expect(jwksCovers(set, "new")).toBe(false);
    expect(jwksCovers(set, null)).toBe(false);
    expect(jwksCovers([{ kty: "RSA" }], null)).toBe(true);
  });
});
