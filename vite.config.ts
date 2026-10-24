import devServer from "@hono/vite-dev-server"
import path from "path"
const __dirname = import.meta.dirname
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { inspectAttr } from 'kimi-plugin-inspect-react'
import { VitePWA } from "vite-plugin-pwa"

// https://vite.dev/config/
export default defineConfig({
  plugins: [
    // v7/C9: /metrics must reach the Hono app in dev too (Prometheus scrape).
    // v8/D6: /healthz + /readyz likewise (unauthenticated k8s-style probes).
    devServer({ entry: "api/boot.ts", exclude: [/^\/(?!api\/|metrics$|healthz$|readyz$).*$/] }),
    inspectAttr(), react(),
    // PWA: installable app shell, offline fallback, Web Push (public/push-sw.js).
    // API, metrics and health routes are never served from the cache — an
    // operator must not act on stale plant data. See docs/pwa.md.
    VitePWA({
      registerType: "autoUpdate",
      injectRegister: false,
      includeAssets: ["icons/*.png"],
      manifest: {
        name: "Gateway Monitoring Platform",
        short_name: "Gateway",
        description: "Device monitoring, alarms and commissioning for PV and BESS sites",
        theme_color: "#0f172a",
        background_color: "#0f172a",
        display: "standalone",
        start_url: "/",
        scope: "/",
        icons: [
          { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
          { src: "/icons/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
        shortcuts: [
          { name: "Alarms", url: "/alarms" },
          { name: "Commissioning", url: "/commissioning" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,png,svg,woff2}"],
        maximumFileSizeToCacheInBytes: 6 * 1024 * 1024,
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//, /^\/metrics/, /^\/healthz/, /^\/readyz/],
        importScripts: ["/push-sw.js"],
        cleanupOutdatedCaches: true,
      },
      devOptions: { enabled: false },
    }),
  ],
  server: {
    port: 3000,
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@contracts": path.resolve(__dirname, "./contracts"),
      "@db": path.resolve(__dirname, "./db"),
      "db": path.resolve(__dirname, "./db"),
    },
  },
  envDir: path.resolve(__dirname),
  build: {
    outDir: path.resolve(__dirname, "dist/public"),
    emptyOutDir: true,
  },
});
