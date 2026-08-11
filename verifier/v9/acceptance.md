# v9 acceptance — AI forecast + portfolio optimizer

Spec: /mnt/agents/output/SPEC-v9.md (contracts sacred).

## EN (Enertrek execution layer)
- EN.1 migration 0013 applied: ems_plans table exists with org_id, unique-ish
  overlap semantics handled by supersede; drizzle emsPlans in schema.
- EN.2 PUT /api/v1/devices/:id/ems-plan: creates active plan; overlapping
  active plans superseded (response counts them); 400 on bad span/unsorted/
  >192/bad kw; 401 without key; 404 foreign-org device.
- EN.3 GET returns current-or-next active plan, else null.
- EN.4 Controller executes plan setpoint as step function (register read-back
  on ESMU sim :5022), result prefixed plan:<source>, userId null, audited.
- EN.5 Priority: peak-shaving > fresh plan > schedules > idle; stale plan not
  executed + lazily expired; SOC guards apply; EMS_TICK_S<=0 disables.
- EN.6 probe-v9-ems-plan.ts ALL PASS (8 checks) incl. cleanup.
- EN.7 tsc -b clean; npm test 25/25; v8 probes unaffected (spot: ems 9/9,
  rest-energy 10/10, multitenancy 9/9).

## VT (VoltTrade brain)
- VT.1 _shared pure TS modules import under Node tsx (no Deno APIs): types,
  pv, load, price, optimize, enertrek-push, weather, holidays.
- VT.2 Optimizer correctness on known-optimum synthetics: (a) TOU valley
  charge + peak discharge, SOC never out of [socMin,socMax], reserve
  respected; (b) PV surplus charges first; (c) flat zero price → no cycling;
  (d) determinism — two runs byte-identical; (e) energy balance exact.
- VT.3 Quantiles: p10 ≤ p50 ≤ p90 on all forecast outputs.
- VT.4 Migration 20260811130000 creates 5 tables + cron rows guarded on
  app.settings (mirrors enertrek sync pattern).
- VT.5 Edge functions are thin wrappers; champion/challenger promotion rule
  implemented (30d nMAE < champion×0.95).
- VT.6 UI /admin/optimizer: tomorrow chart, accuracy tiles, procurement
  shadow table + Confirm action, runs log.
- VT.7 pushEmsPlan targets Contract A exactly (path/body/auth).
- VT.8 docs/forecast-optimizer.md complete (models, accuracy expectations,
  cron timetable, fail-safe, shadow workflow, env vars).
- VT.9 Existing functions reused not duplicated — documented REUSED/ADDED.

## Integration (orchestrator)
- INT.1 e2e: harness pushes real plan → live Enertrek executes → sim
  register follows plan steps (erp-sim pattern).
- INT.2 Forecast sanity on real synced data (if present): no crash,
  outputs monotonic quantiles, sane magnitudes vs history.
- INT.3 Run records verifier/runs/*-v9-*.json; README index; plan closeout.
