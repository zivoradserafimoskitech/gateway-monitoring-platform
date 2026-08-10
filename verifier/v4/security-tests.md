# v4 — Security test battery & dispositions

Executed against the running dev stack (app :3000, broker :1883) plus static
code audit, by a security subagent; re-probed by the orchestrator after
remediation. Date: 2026-08-10.

## Probe results (SEC-01 … SEC-10)

| Probe | Result | Evidence |
|-------|--------|----------|
| SEC-01 input validation on mutations | PASS (with notes) | zod schemas reject typed garbage; empty-body POST returns 500 instead of 400 (F-11, LOW) |
| SEC-02 SQL injection | PASS — not reproducible | drizzle-orm parameterizes all queries; raw `sql` usages audited, no string-concatenated user input |
| SEC-03 XSS | PASS | no `dangerouslySetInnerHTML` sink; device names render through React escaping |
| SEC-04 unauthenticated mutations | FAIL → FIXED | all tRPC procedures were `publicQuery` (F-01 CRITICAL) → optional Bearer guard added (`API_TOKEN`), verified 401/401/200 |
| SEC-05 secret hygiene | FAIL → FIXED | `.env` (live TiDB DSN + APP_SECRET) was baked into the Docker image via `COPY . .` (F-05 HIGH) → `.dockerignore` rewritten; compose default credentials removed (F-07) |
| SEC-06 MQTT anonymous pub/sub | FAIL → FIXED | broker accepted anonymous connections on 0.0.0.0 (F-02 CRITICAL) → optional `MQTT_USERNAME`/`MQTT_PASSWORD` auth; verified anonymous/bad-creds REJECTED, good-creds CONNECTED |
| SEC-07 DoS surfaces | PARTIAL → improved | 50 MB body limit → 2 MB (F-09), verified 413 on a 3 MB POST; unbounded list queries remain (F-10 LOW, roadmap) |
| SEC-08 dependency audit | IMPROVED | `npm audit fix`: 21 vulns (12 high) → 6 moderate, all dev-tooling-only (hono serve-static Windows path traversal — N/A on Linux runtime; esbuild via drizzle-kit — breaking fix declined, documented) |
| SEC-09 error/stack leakage | FAIL → FIXED | tRPC `errorFormatter` now strips `stack` outside development (F-06) |
| SEC-10 prototype pollution / mass assignment | PASS | JSON payloads with `__proto__`/`constructor` keys do not mutate object prototypes; zod strips unknown keys on mutations — but see Eng #6 (over-stripping stripped codec fields; fixed) |

Additional live probes by the orchestrator after remediation:
- `API_TOKEN=probe-secret-123`: no token → 401 `{"error":"Unauthorized"}`;
  wrong token → 401; correct token → 200. **PASS**
- Broker with `MQTT_USERNAME/PASSWORD`: anonymous → `Not authorized`;
  wrong password → `Not authorized`; correct → CONNECTED. **PASS**
- 3 MB POST to `/api/trpc/*` → **413** (limit 2 MB). **PASS**

## Findings & dispositions

| # | Severity | Finding | Disposition |
|---|----------|---------|-------------|
| F-01 | CRITICAL | Zero authentication: every tRPC query/mutation is public — anyone on the network can read fleet data, create/delete gateways and meters, change alarm rules | **FIXED (gate)** — optional Bearer-token guard on `/api/trpc/*` (`API_TOKEN` env) + frontend sends `VITE_API_TOKEN`. Full user-level authN/authZ (sessions, roles) is explicitly roadmap — platform currently targets trusted-LAN/single-operator deployments; with `API_TOKEN` unset the guard is off (dev default) |
| F-02 | CRITICAL | aedes broker allows anonymous pub/sub on all interfaces — any host can inject telemetry or impersonate gateways | **FIXED (gate)** — optional `MQTT_USERNAME`/`MQTT_PASSWORD` auth in `scripts/broker.ts` (enabled = reject anonymous); simulator passes creds from env; loud startup warning when anonymous; `MQTT_BIND_HOST` to restrict interface. EMQX (with auth) already used in prod compose |
| F-03 | HIGH | Auto-provisioning: any MQTT publisher with a fresh UID is inserted into the fleet (ghost-gateway injection; stray `uid='test'` row found in DB) | **FIXED (gate + cleanup)** — `MQTT_AUTO_PROVISION=0` disables auto-provision (log-once per denied UID); stray `test` gateway deleted by `repair-orphans.ts`. Default remains ON because zero-touch onboarding is the product's operating model — documented accepted risk |
| F-04 | HIGH | SSRF: poller connects to arbitrary `host:port` from meter config — an API caller can make the server dial internal services | **DOCUMENTED (accepted risk)** — with F-01's token guard, only authorized operators reach the mutation; deployment guidance: egress firewall on the poller host. Proper fix (IP allow-list / private-range refusal) on roadmap |
| F-05 | HIGH | `.env` with live TiDB DSN + APP_SECRET baked into Docker image | **FIXED** — `.dockerignore` excludes `.env`, `.env.*`, `verifier/runs`, `upload` |
| F-06 | MEDIUM | Stack traces leaked in tRPC error responses | **FIXED** — `errorFormatter` strips `stack` when `NODE_ENV=production` |
| F-07 | MEDIUM | `docker-compose.prod.yml` shipped default credentials (EMQX admin/public, MySQL enertrek/enertrek, Timescale) and exposed admin/DB ports on all interfaces | **FIXED** — all secrets now `${VAR:?set VAR}` (fail-fast); 18083/5433/3307 bound to 127.0.0.1 |
| F-08 | MEDIUM | CSV export formula injection (`=`, `+`, `-`, `@` leading cells execute in Excel) | **FIXED** — `csvCell()` in Reports.tsx prefixes `'` and quotes; all CSV lines mapped through it |
| F-09 | LOW | 50 MB request body limit on API | **FIXED** — 2 MB `bodyLimit`; verified 413 |
| F-10 | LOW | Unbounded list queries (no pagination caps on meters/telemetry/alarms lists) | **DOCUMENTED** — roadmap (cursor pagination); table sizes currently small |
| F-11 | LOW | Empty-body POST returns 500 instead of 400 | **DOCUMENTED** — cosmetic; roadmap |
| F-12 | INFO | No rate limiting on API/MQTT paths | **DOCUMENTED** — roadmap (gateway-level throttling recommended) |
| F-13 | INFO | Dependency vulnerabilities in dev tooling (npm audit, see SEC-08) | **PARTIALLY FIXED** — all fixable non-breaking applied; 6 moderate remain in dev-only packages (no production runtime exposure); breaking drizzle-kit downgrade declined |
| F-14 | INFO | Security headers absent on HTTP responses (CSP, X-Frame-Options, etc.) | **DOCUMENTED** — roadmap (hono/secure-headers) |
| F-15 | INFO | Broker/bind surface: dev broker listens on 0.0.0.0 by default | **FIXED (option)** — `MQTT_BIND_HOST` env; prod uses EMQX with auth |

Negative results (tested, not vulnerable): SQL injection (SEC-02), XSS sinks
(SEC-03), prototype pollution / mass assignment (SEC-10).
