// The origin the browser sees. This is what the OIDC redirect_uri is built
// from, and an identity provider compares it EXACTLY against the URI
// registered with it — so behind the TLS-terminating proxy, getting the scheme
// wrong is not a cosmetic bug, it is every SSO login failing.
import { afterEach, describe, expect, it } from "vitest";
import { isSecureReq, publicOrigin } from "../api/lib/auth";

const req = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers });

afterEach(() => {
  delete process.env.PUBLIC_URL;
});

describe("publicOrigin", () => {
  it("uses https when the proxy says the browser used https, though the app saw http", () => {
    // deploy/nginx.conf terminates 443 and proxies over plain HTTP, setting
    // X-Forwarded-Proto and Host. c.req.url alone would say http://.
    const r = req("http://app:3000/api/auth/oidc/1/start", {
      "x-forwarded-proto": "https",
      host: "cloud.example.com",
    });
    expect(publicOrigin(r)).toBe("https://cloud.example.com");
  });

  it("takes the authority from Host, not from the internal upstream address", () => {
    const r = req("http://127.0.0.1:3000/x", { host: "cloud.example.com" });
    expect(publicOrigin(r)).toBe("http://cloud.example.com");
  });

  it("falls back to the request URL with no proxy headers at all", () => {
    expect(publicOrigin(req("http://localhost:3000/x"))).toBe("http://localhost:3000");
  });

  it("lets PUBLIC_URL win over anything the request claims", () => {
    // The only answer that cannot be wrong about a proxy chain.
    process.env.PUBLIC_URL = "https://cloud.example.com/some/path";
    const r = req("http://app:3000/x", { "x-forwarded-proto": "http", host: "internal" });
    expect(publicOrigin(r)).toBe("https://cloud.example.com");
  });
});

describe("isSecureReq", () => {
  it("trusts the forwarded scheme, and the URL when there is no proxy", () => {
    expect(isSecureReq(req("http://app/x", { "x-forwarded-proto": "https" }))).toBe(true);
    expect(isSecureReq(req("https://app/x"))).toBe(true);
    expect(isSecureReq(req("http://app/x"))).toBe(false);
  });
});
