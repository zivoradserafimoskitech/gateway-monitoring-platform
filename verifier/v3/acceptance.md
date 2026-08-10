# v3 acceptance — ESMU (BAMS) Modbus TCP protocol integration

Source document: `ESMU_MODBUS_V2.1_EN.pdf` (vendor, 49 pp, uploaded by user).
ESMU = battery stack management unit; Modbus TCP server (default port 502);
unit 1 = stack object, units 2..21 = ESBCM string objects (block base
100 + (N−1)×3000); FC03/FC04 reads, ≤120 regs/read; 32-bit high-word-first;
biased registers (current −1600 A, temperature −40 °C).

| # | Criterion | Method |
|---|-----------|--------|
| E1 | Profile validation: 30/30 seeded profiles parse; ESMU offset/stride fields well-formed; worst-case shifted addresses within PDU space | `scripts/validate-profiles.ts` |
| E2 | Stack telemetry end-to-end: ≥20 keys decoded on the stack object; biased registers physical (idle current ≈0 A not 1600 A; temps 0–45 °C); u32 counters >0; FC3 holding regs read (stringCount=2, heartbeat>0); 0 poll failures | `scripts/test-esmu-e2e.ts` |
| E3 | addressStride correctness: both string objects decode ≥20 keys; SOC ≥5 (shifted reads hit real registers); string 1 vs string 2 report different SOC (58 vs 62) proving per-unit blocks (100 vs 3100) | `scripts/test-esmu-e2e.ts` |
| E4 | Alarms: bmsStatusCode=8 (ESMU fault enum) fires critical alarm; string SOC<30 fires warning; both auto-resolve after recovery | `scripts/test-esmu-e2e.ts` |
| E5 | Demo integration: ESMU stack + 2 strings provisioned in the app (port 5022 sim), all 3 online with fresh telemetry alongside the original 11 demo devices | `scripts/provision-esmu-demo.ts` + `scripts/verify-c9.ts` |
| E6 | `npm run check` + `npm run build` clean | shell |
| E7 | Run records appended (incl. failures), verifier README updated, version snapshot saved | verifier/runs + website_version_manager |

Out of scope (documented in profile notes): FC02 discrete alarm bits, FC06/FC10
control writes, FC41 time sync, per-cell arrays (191+), pack SOC table (151–190).
