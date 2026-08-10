import { createTRPCReact } from "@trpc/react-query";
import { httpBatchLink } from "@trpc/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import superjson from "superjson";
import type { AppRouter } from "../../api/router";
import type { ReactNode } from "react";

export const trpc = createTRPCReact<AppRouter>();

// v7 hotfix: cookie-independent session token for embedded contexts (platform
// preview iframe blocks third-party cookies even with SameSite=None). The SPA
// stores the token from auth.login and sends it as x-session-token; the server
// accepts it as a cookie fallback (api/context.ts). In-memory fallback covers
// sandboxed iframes where localStorage throws.
const TOKEN_KEY = "et_session_token";
let memToken: string | null = null;

export function getSessionToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? memToken;
  } catch {
    return memToken;
  }
}

export function setSessionToken(token: string | null): void {
  memToken = token;
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* sandboxed storage — memory-only session */
  }
}

const queryClient = new QueryClient();
const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      // Optional API token guard (server: API_TOKEN). Build the frontend with
      // VITE_API_TOKEN set for protected deployments; unset = open demo mode.
      headers() {
        const token = import.meta.env.VITE_API_TOKEN as string | undefined;
        const session = getSessionToken();
        return {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(session ? { "x-session-token": session } : {}),
        };
      },
      fetch(input, init) {
        return globalThis.fetch(input, {
          ...(init ?? {}),
          credentials: "include",
        });
      },
    }),
  ],
});

export function TRPCProvider({ children }: { children: ReactNode }) {
  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        {children}
      </QueryClientProvider>
    </trpc.Provider>
  );
}
