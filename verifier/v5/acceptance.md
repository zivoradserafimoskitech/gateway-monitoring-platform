# v5 acceptance — resolve all 19 remaining engineering findings

Goal (user, MK): "Реши ги сите" — fix every remaining finding from
`verifier/v4/review-engineering.md` (#2, #3, #5, #7–#14, #16, #18–#24).

| # | Criterion | Method |
|---|-----------|--------|
| A1 | Every one of the 19 findings has a code/config change + disposition entry in `verifier/v5/fixes.md` with file evidence | review |
| A2 | #2: meter/gateway offline threshold = max(120s, 2.5×pollInterval); slow-poll device no longer flaps | unit/e2e probe |
| A3 | #3: telemetry batch writer bounded + retry with backoff + drain on SIGTERM | code review + probe (kill -TERM drains queue) |
| A4 | #5: Timescale store persists values_json (schema + insert parity with MySQL store) | code review |
| A5 | #7: breach state rebuilt from DB on boot; no duplicate alarm storm after restart; acked alarms don't re-fire | e2e probe (restart with active breach → no duplicate) |
| A6 | #8: server-side day aggregation in UTC; single conversion point documented | code review + query check |
| A7 | #9: register defs support explicit `unit`; power normalization uses it when present, heuristic only as fallback | code + unit test |
| A8 | #10/#11/#12: poller — no collateral socket kill on per-device error; single in-flight conn per key; exponential backoff on repeated failures | unit test / code review |
| A9 | #13/#20: dashboard KPIs + MeterDetail use PRIMARY_POWER_KEY contract | code review + UI render check |
| A10 | #14: alarms.counts uses SQL COUNT/GROUP BY | code review |
| A11 | #16: gwCache evicted on gateway delete/update | code review + probe |
| A12 | #18: reports batch queries (no per-meter-per-day N+1) | code review |
| A13 | #19: alarm-rule metric picker populated from the device's profile register map | UI probe |
| A14 | #21: derived energy values labeled in UI | UI probe |
| A15 | #22: destructive scripts refuse to run against non-localhost DB unless ALLOW_UNSAFE_PROD=1 | run probe |
| A16 | #23: unit test suite (node:test via tsx) covers codec offset/stride, csvCell, threshold calc, backoff calc; `npm test` green | run |
| A17 | #24: drizzle-kit generate/migrate wired as npm scripts + README note | code review |
| A18 | Regression: tsc clean, build ok, ESMU e2e 6/6, demo fleet 14/14 online, security spot-probes still pass | run |
| A19 | Run records in verifier/runs/, README index appended, version saved | discipline |
