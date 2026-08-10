# v4 acceptance — principal-engineer review + security audit & remediation

Goal (user, MK): senior-engineer review of platform illogicalities/shortcomings +
security test-check with corrections.

| # | Criterion | Method |
|---|-----------|--------|
| V1 | Engineering review report: architecture/logic illogicalities & shortcomings, each with concrete file/line evidence and severity | reviewer subagent → `verifier/v4/review-engineering.md` |
| V2 | Security test battery executed against the running app + static code audit; every probe result recorded (pass/fail + evidence) | security subagent + own probes → `verifier/v4/security-tests.md` |
| V3 | All CRITICAL and HIGH security findings either fixed (code change) or explicitly documented as accepted-risk with rationale; MEDIUM fixed where cheap | fixes + `verifier/v4/security-tests.md` disposition column |
| V4 | Regression after fixes: `npm run check`, `npm run build`, and one e2e (pv or esmu) pass; app still healthy with demo fleet online | shell + verify-c9 |
| V5 | Run records for every verification run (incl. failures) in `verifier/runs/`; README index appended; version snapshot saved | verifier discipline |

Security battery (minimum probe set):
- SEC-01 input validation on mutation endpoints (oversized/typed garbage)
- SEC-02 SQL injection attempts on string inputs / raw SQL usage audit
- SEC-03 XSS vectors (stored names → React render; dangerouslySetInnerHTML audit)
- SEC-04 unauthenticated access to mutating endpoints (report + fix via optional API token)
- SEC-05 secret hygiene (.env in repo/gitignore, hardcoded creds, DSN exposure)
- SEC-06 MQTT broker anonymous pub/sub check (+fix: optional auth)
- SEC-07 DoS surfaces: unbounded inputs, poll interval floors, batch sizes
- SEC-08 `npm audit` dependency vulnerabilities
- SEC-09 error/stack leakage in API responses
- SEC-10 prototype-pollution / mass-assignment style payloads
