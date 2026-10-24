import type { Hono } from "hono";
import type { HttpBindings } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import fs from "fs";
import path from "path";

type App = Hono<{ Bindings: HttpBindings }>;

export function serveStaticFiles(app: App) {
  const distPath = path.resolve(import.meta.dirname, "../dist/public");

  // PWA: the service worker and manifest must never be cached by the browser
  // or a proxy, or a deploy would keep serving the previous app shell.
  app.use("*", async (c, next) => {
    await next();
    if (/^\/(sw\.js|push-sw\.js|manifest\.webmanifest|registerSW\.js)$/.test(c.req.path)) {
      c.header("Cache-Control", "no-cache, no-store, must-revalidate");
    }
  });
  app.use("*", serveStatic({ root: "./dist/public" }));

  app.notFound((c) => {
    const accept = c.req.header("accept") ?? "";
    if (!accept.includes("text/html")) {
      return c.json({ error: "Not Found" }, 404);
    }
    const indexPath = path.resolve(distPath, "index.html");
    const content = fs.readFileSync(indexPath, "utf-8");
    return c.html(content);
  });
}
