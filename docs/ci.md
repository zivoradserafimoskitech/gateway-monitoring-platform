# CI / quality gates

Pipeline: `.github/workflows/ci.yml` (D7). Two jobs:

| Job | Trigger | Gates |
| --- | --- | --- |
| `quality` | push / PR to `main`, or `workflow_dispatch` on any branch | lockfile registry guard → `npm ci` → typecheck (`npm run check`, i.e. `tsc -b` — the root `tsconfig.json` is a solution file, plain `tsc --noEmit` would no-op) → `npm run lint` → `npm run test:coverage` (vitest v8 coverage, thresholds enforced) → `npm run build` → npm audit gate (runtime deps, high+) → npm audit report (dev deps, informational) |
| `e2e` | `workflow_dispatch` only | Playwright chromium specs against a live dev server backed by a `mysql:8` service container the job starts itself |

## Coverage (D7.3)

Provider: `@vitest/coverage-v8`, configured in `vitest.config.ts`. Thresholds
in force: lines 39, statements 37, branches 28, functions 22. They sit a couple
of points below the measured baseline so the gate trips on real regressions
rather than on noise — see the comment in `vitest.config.ts` for the current
measurement. Raise them as coverage improves. Run locally:
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
npm run dev                          # app + API on :3000 (requires DATABASE_URL in .env)
npx tsx scripts/seed-e2e-users.ts    # once, to create the two accounts
npx playwright test                  # or: npm run test:e2e
```

First-time setup: `npx playwright install chromium`.

### Why the E2E job is manual-only in CI

It is manual because a browser suite takes minutes and does not belong on every
push — not because it cannot run here. The job is **self-contained**: it starts
a `mysql:8` service container, builds the schema from `db/schema.ts` the same
way the demo image does, seeds the two accounts the specs sign in with
(`scripts/seed-e2e-users.ts`), then starts the dev server and runs Playwright.

It previously depended on a `DATABASE_URL` secret pointing at the demo TiDB,
which sits behind Aliyun PrivateLink and is unroutable from a GitHub-hosted
runner. The three login specs could therefore never pass, and the job was red
by construction. Nothing in the suite needs *that* database — it needs *a*
database with two users in it.

No secrets are required. The credentials are disposable and the seed script
refuses to write them anywhere that is not clearly local.

Run it before a release, or when touching authentication or the login flow.

## npm audit policy

Two steps, deliberately split:

| Step | Scope | Blocking |
| --- | --- | --- |
| `npm audit gate (high+, runtime dependencies)` | `--omit=dev` — what actually ships | yes, on any high or critical |
| `npm audit report (dev dependencies, informational)` | the whole tree | no |

A vulnerability in the bundler or the linter is real and worth tracking, but it
is not reachable by an attacker against a deployed gateway. Letting it block
every pull request is how audit gates end up switched off entirely, so it is
reported loudly and gates nothing.

The allowlist (`AUDIT_ALLOW`) is **empty**. It previously carried two `xlsx`
advisories; `xlsx` was replaced by `exceljs` and is no longer a dependency, so
those entries suppressed nothing and would have hidden a genuine finding on any
package that reused the id. Add an entry only alongside a comment naming the
package, why no fix exists, and when to revisit.

Known remaining: `uuid` below 11.1.1 via `exceljs`, the one advisory npm cannot
resolve without downgrading `exceljs` across a major version. It is moderate,
so it does not gate.

## Lockfile registry guard

A step before the install fails the build if any tarball in
`package-lock.json` resolves from anywhere but the public registry.

This exists because of a real outage: 479 of the lockfile's 898 tarball URLs
pointed at a private mirror the runners cannot reach, so `npm ci` stalled and
**every CI run from at least 2026-08-13 to 2026-09-11 failed before typecheck,
lint, tests or build ever executed**. The guard runs first so the failure names
the cause instead of timing out.

## Scale smoke (placeholder)

A commented-out step in `ci.yml` sketches the v2 scale-test procedure
(`scripts/provision-fleet.ts` → simulator load → `scripts/verify-scale.ts` →
`scripts/cleanup-scale.ts`; see `verifier/README.md`, "v2 — scale test").
It needs a long soak (~10 min, ~507 samples/s, 500 simulated gateways) and a
reachable TiDB, so it belongs in a nightly/scheduled workflow against
staging — not in PR CI.
