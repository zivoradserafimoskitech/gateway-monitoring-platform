// Outbound-request guard for user-supplied URLs (webhook notification
// channels). Without it an operator can point a channel at the cloud metadata
// service or any internal host and use delivery status as an oracle —
// server-side request forgery with the platform's own network position.
//
// Default is deny-private. On-premise installations that legitimately post to
// an internal collector set WEBHOOK_ALLOW_PRIVATE=true.
import dns from "node:dns/promises";
import net from "node:net";

export class BlockedEgressError extends Error {}

const allowPrivate = () => process.env.WEBHOOK_ALLOW_PRIVATE === "true";

function ipv4IsPrivate(ip: string): boolean {
  const p = ip.split(".").map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  if (a === 0) return true; // "this network"
  if (a === 10) return true; // RFC1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC1918
  if (a === 192 && b === 168) return true; // RFC1918
  if (a === 192 && b === 0) return true; // IETF protocol assignments
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a >= 224) return true; // multicast + reserved
  return false;
}

function ipv6IsPrivate(ip: string): boolean {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, "");
  if (s === "::" || s === "::1") return true;
  // IPv4-mapped (::ffff:10.0.0.1) inherits the IPv4 verdict.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) return ipv4IsPrivate(mapped[1]);
  const head = parseInt(s.split(":")[0] || "0", 16);
  if ((head & 0xfe00) === 0xfc00) return true; // unique-local fc00::/7
  if ((head & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((head & 0xff00) === 0xff00) return true; // multicast
  return false;
}

export function isPrivateAddress(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) return ipv4IsPrivate(ip);
  if (v === 6) return ipv6IsPrivate(ip);
  return true; // not an address we can reason about — refuse
}

/**
 * Validate shape only (no DNS). Safe to call from input validation, where a
 * blocking lookup per keystroke is undesirable.
 */
export function parseEgressUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new BlockedEgressError("target must be an absolute URL");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && allowPrivate())) {
    throw new BlockedEgressError("webhook target must use https");
  }
  if (url.username || url.password) {
    throw new BlockedEgressError("webhook target must not embed credentials");
  }
  if (!allowPrivate() && net.isIP(url.hostname) && isPrivateAddress(url.hostname)) {
    throw new BlockedEgressError("webhook target resolves to a private address");
  }
  return url;
}

/**
 * Full check including DNS resolution. Call this immediately before the
 * request so a name that resolved publicly at creation time cannot be
 * re-pointed at an internal host later (DNS rebinding).
 */
export async function assertEgressAllowed(raw: string): Promise<URL> {
  const url = parseEgressUrl(raw);
  if (allowPrivate()) return url;
  if (net.isIP(url.hostname)) return url; // already checked above
  let addrs: { address: string }[];
  try {
    addrs = await dns.lookup(url.hostname, { all: true });
  } catch {
    throw new BlockedEgressError(`cannot resolve ${url.hostname}`);
  }
  if (addrs.length === 0) throw new BlockedEgressError(`cannot resolve ${url.hostname}`);
  for (const a of addrs) {
    if (isPrivateAddress(a.address)) {
      throw new BlockedEgressError("webhook target resolves to a private address");
    }
  }
  return url;
}
