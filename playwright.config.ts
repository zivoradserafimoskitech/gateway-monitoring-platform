// D7.2/D7.4: Playwright E2E config — runs against the dev server on :3000.
// Start the app first (`npm run dev`) or set E2E_BASE_URL to a deployed URL.
// CI note: the E2E job needs a running app + reachable DATABASE_URL (TiDB),
// see .github/workflows/ci.yml and docs/ci.md.
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1, // specs share the seeded users; keep execution deterministic
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["list"]] : [["list"]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:3000",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
