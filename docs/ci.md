# CI / quality gates

Pipeline: `.github/workflows/ci.yml` (D7). Two jobs:

| Job | Trigger | Gates |
| --- | --- | --- |
| `quality` | push / PR to `main` | `npm ci` → typecheck (`npm run check`, i.e. `tsc -b` — the root `tsconfig.json` is a solution file, plain `tsc --noEmit` would no-op) → `npm run test:coverage` (vitest v8 coverage, thresholds enforced) → `npm run build` → npm audit gate (high+) |
| `e2e` | `workflow_dispatch` only | Playwright chromium specs against a live dev server |

## Coverage (D7.3)

Provider: `@vitest/coverage-v8`, configured in `vitest.config.ts`. Measured
baseline of the current 25-test suite:

| Metric | Measured | Threshold |
| --- | --- | --- |
| Lines | 26.23 % | 21 % |
| Statements | 24.35 % | 19 % |
| Branches | 16.75 % | 11 % |
| Functions | 10.46 % | 5 % |

Thresholds sit ~5 points below the measured values so the gate trips on real
regressions, not on noise. Raise them as coverage improves. Run locally:
`npm run test:coverage` (exit code 1 when below threshold; `npm test` stays
the fast no-coverage path).

Environment note: this dev sandbox mounts the repo on FUSE, where vitest's
coverage `.tmp` directory hits transient read-after-write `ENOENT`s. Outside
CI the coverage `reportsDirectory` therefore defaults to the OS temp dir
(`os.tmpdir()/enertrek-vitest-coverage`); in CI (`CI=1`) reports land in the
standard `./coverage/` (`lcov.info` + `lcov-report/`). Override with
`COVERAGE_DIR`. If you ever hit `ENOENT: no such file or directory, read`
from a stale run: `rm -rf coverage` and re-run.

## Playwright E2E (D7.2 / D7.4)

Config: `playwright.config.ts` — `baseURL http://localhost:3000` (override
with `E2E_BASE_URL`), single chromium project, `testDir tests/e2e`, no
retries locally (1 in CI), traces/screenshots kept on failure.

Specs in `tests/e2e/login.spec.ts`:

1. `/` shows the login page when unauthenticated.
2. `admin@enertrek.local / admin1234` logs in → Dashboard heading + Sign out
   button visible; signing out returns to the login page.
3. `viewer@enertrek.local / viewer123` reaches the dashboard, but a
   `sites.create` tRPC mutation issued via `page.evaluate(fetch …)` is
   rejected with `-32003 FORBIDDEN` (HTTP 403) — RBAC enforced server-side.
4. Wrong password → visible "Invalid email or password" error, stays on the
   login page.

Run locally:

```bash
npm run dev          # app + API on :3000 (requires DATABASE_URL in .env)
npx playwright test  # or: npm run test:e2e
```

First-time setup: `npx playwright install chromium`.

### Why the E2E job is manual-only in CI

The suite needs a **running app + reachable TiDB**. The demo database lives
behind Aliyun PrivateLink — GitHub-hosted runners cannot route to it — so the
`e2e` job is gated to `workflow_dispatch`. To enable it:

- run it on a **self-hosted runner inside the VPC**, or point `DATABASE_URL`
  at a staging DB; and
- seed the users the specs rely on (`scripts/seed-admin.ts` for the admin;
  a viewer user `viewer@enertrek.local / viewer123`).

Required GitHub secret for the E2E job:

| Secret | Purpose |
| --- | --- |
| `DATABASE_URL` | TiDB DSN reachable from the runner, with seeded users |

## npm audit policy

The `quality` job runs `npm audit --audit-level=high --json` and **hard-fails
on any high/critical advisory not on the documented allowlist**. Current
allowlist (both in `xlsx`, no upstream fix published — SheetJS only ships
fixes via its paid CDN builds):

- `GHSA-4r6h-8v6p-xvw6` — prototype pollution
- `GHSA-5pgg-2g8v-p4x9` — regular expression denial of service

The 6 remaining moderates are dev-only (`esbuild` <0.25 via
`drizzle-kit`/`@esbuild-kit`, vite dev chain) and never reach the runtime
image; `--audit-level=high` does not gate on them. Revisit the allowlist when
an `xlsx` fix or replacement lands. Note: the sandbox npm mirror does not
implement the audit endpoint — verify locally with
`npm audit --audit-level=high --registry=https://registry.npmjs.org`.

## Scale smoke (placeholder)

A commented-out step in `ci.yml` sketches the v2 scale-test procedure
(`scripts/provision-fleet.ts` → simulator load → `scripts/verify-scale.ts` →
`scripts/cleanup-scale.ts`; see `verifier/README.md`, "v2 — scale test").
It needs a long soak (~10 min, ~507 samples/s, 500 simulated gateways) and a
reachable TiDB, so it belongs in a nightly/scheduled workflow against
staging — not in PR CI.
