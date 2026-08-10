import type { FetchCreateContextFnOptions } from "@trpc/server/adapters/fetch";
import { SESSION_COOKIE, userForToken } from "./lib/auth";
import type { User } from "@db/schema";

export type TrpcContext = {
  req: Request;
  resHeaders: Headers;
  user: User | null;
  sessionToken: string | null;
};

function readCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export async function createContext(
  opts: FetchCreateContextFnOptions,
): Promise<TrpcContext> {
  // v7/C1: AUTH_REQUIRED=false keeps the open demo mode (dev only).
  if (process.env.AUTH_REQUIRED === "false") {
    return { req: opts.req, resHeaders: opts.resHeaders, user: null, sessionToken: null };
  }
  // Cookie first (first-party); x-session-token header fallback for embedded
  // contexts (platform preview iframe) where third-party cookies are blocked.
  const headerToken = opts.req.headers.get("x-session-token");
  const token =
    readCookie(opts.req.headers.get("cookie"), SESSION_COOKIE) ??
    (headerToken && /^[a-f0-9]{64}$/i.test(headerToken) ? headerToken : null);
  let user: User | null = null;
  try {
    user = await userForToken(token);
  } catch {
    user = null; // auth backend hiccup must not take the API down; treat as anonymous
  }
  return { req: opts.req, resHeaders: opts.resHeaders, user, sessionToken: token };
}
