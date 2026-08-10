// v8/D2 probe: settlement energy-intervals REST endpoint.
//  a) GET /api/v1/devices/1/energy over the last 2h, bucketMin=15 → exactly 8
//     consecutive UTC-aligned buckets, measured quality, non-negative deltas,
//     sane avgPowerKw (meter 1 PEM3000 is live with import/export counters).
//  b) bucketMin=60 over yesterday (full UTC day) → 24 buckets; consistency:
//     the day's energy total matches a bucketMin=15 query over the same range.
//  c) unknown device id → 404.
//  d) range > 31 days / bad bucketMin / from>=to / unparsable dates → 400.
//  e) no key → 401.
//  f) revoked key → 401 immediately (then the key row is the cleanup).
// Run: npx tsx scripts/probe-v8-rest-energy.ts  (dev server on :3000)
const BASE = "http://localhost:3000";
const jars: Record<string, string> = {};

let fails = 0;
function probe(name: string, ok: boolean, detail: unknown): void {
  console.log(ok ? "PASS" : "FAIL", name, "->", JSON.stringify(detail).slice(0, 240));
  if (!ok) fails++;
}

async function trpc(proc: string, payload: unknown, who?: string): Promise<unknown> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (who && jars[who]) headers.cookie = jars[who];
  const res = await fetch(`${BASE}/api/trpc/${proc}?batch=1`, {
    method: "POST",
    headers,
    body: JSON.stringify({ "0": { json: payload } }),
  });
  const setCookie = res.headers.get("set-cookie");
  if (who && setCookie) jars[who] = setCookie.split(";")[0];
  const body = await res.json();
  const b = Array.isArray(body) ? body[0] : body;
  if (b.error) throw new Error(b.error.json?.message ?? JSON.stringify(b.error));
  return b.result.data.json;
}

async function v1(path: string, key?: string): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  if (key) headers.authorization = `Bearer ${key}`;
  const res = await fetch(`${BASE}/api/v1${path}`, { headers });
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
}

interface Bucket { ts: string; importKwh: number | null; exportKwh: number | null; avgPowerKw: number | null; quality: string }

async function main() {
  await trpc("auth.login", { email: "admin@enertrek.local", password: "admin1234" }, "admin");
  const created = (await trpc("apiKeys.create", { name: "probe-v8-energy", role: "viewer" }, "admin")) as { id: number; key: string; prefix: string };
  const raw = created.key;
  probe("apiKeys.create returns raw etk_ key once", raw.startsWith("etk_") && raw.length > 40, { prefix: created.prefix });

  try {
    // ── (a) last 2h, 15-min buckets ────────────────────────────────────────
    const bucketMs = 15 * 60_000;
    const toMs = Math.floor(Date.now() / bucketMs) * bucketMs;
    const fromMs = toMs - 2 * 3_600_000;
    const q = `from=${new Date(fromMs).toISOString()}&to=${new Date(toMs).toISOString()}&bucketMin=15`;
    const a = await v1(`/devices/1/energy?${q}`, raw);
    const buckets: Bucket[] = a.body?.buckets ?? [];
    const aligned = buckets.every((b, i) => new Date(b.ts).getTime() === fromMs + i * bucketMs);
    const deltasOk = buckets.every((b) => (b.importKwh === null || b.importKwh >= 0) && (b.exportKwh === null || b.exportKwh >= 0));
    const powers = buckets.map((b) => b.avgPowerKw).filter((p): p is number => p !== null);
    const measured = buckets.filter((b) => b.quality === "measured").length;
    // Empty buckets (genuine telemetry gaps) must be present with nulls.
    const emptyWellFormed = buckets.every((b) => (b.importKwh === null ? b.avgPowerKw === null && b.exportKwh === null : true));
    probe(
      "(a) energy 2h/15min → 8 consecutive aligned buckets",
      a.status === 200 && a.body.deviceId === 1 && a.body.bucketMin === 15 && buckets.length === 8 && aligned,
      { status: a.status, n: buckets.length, first: buckets[0]?.ts, last: buckets[7]?.ts },
    );
    // Counter resets are legitimate events: the store flags their buckets
    // estimated (delta kept non-negative via greatest()). Simulator restarts
    // re-base the demo counter and produce such seams in any 2 h window, so
    // sanity bounds apply to measured buckets; estimated buckets only need to
    // be well-formed (they are the designed reset representation).
    const powersM = buckets.filter((b) => b.quality === "measured").map((b) => b.avgPowerKw).filter((p): p is number => p !== null);
    probe(
      "(a) non-negative deltas, sane avgPowerKw, measured quality, empty buckets → nulls",
      deltasOk && powersM.length >= 4 && powersM.every((p) => p >= 0 && p < 500) && measured >= 4 && emptyWellFormed,
      { powers: powers.slice(0, 4), import: buckets.map((b) => b.importKwh), qualities: buckets.map((b) => b.quality) },
    );

    // ── (b) hourly buckets + cross-resolution rollup consistency ───────────
    // NOTE: "yesterday" has no meter-1 rows in this dev DB (feed restarted
    // today; raw retention is 90 d so the telemetry_hourly path is also never
    // triggered by a ≤31 d window). We therefore assert the contract property
    // — bucketMin=60 totals equal the 15-min totals over the same range — on
    // the last 6 full hours, which include a real gap AND a counter reset.
    const hourMs = 3_600_000;
    const toHour = Math.floor(Date.now() / hourMs) * hourMs;
    const fromHour = toHour - 6 * hourMs;
    const qb = `from=${new Date(fromHour).toISOString()}&to=${new Date(toHour).toISOString()}`;
    const b60 = await v1(`/devices/1/energy?${qb}&bucketMin=60`, raw);
    const b15 = await v1(`/devices/1/energy?${qb}&bucketMin=15`, raw);
    const b60b: Bucket[] = b60.body?.buckets ?? [];
    const b15b: Bucket[] = b15.body?.buckets ?? [];
    const sum = (bs: Bucket[]) => bs.reduce((s, b) => s + (b.importKwh ?? 0), 0);
    const consistent = Math.abs(sum(b60b) - sum(b15b)) < 0.05;
    const nonNeg = b60b.every((b) => b.importKwh === null || b.importKwh >= 0);
    probe(
      "(b) last 6h bucketMin=60 → 6 buckets, totals consistent with 15-min resolution",
      b60.status === 200 && b60b.length === 6 && b15b.length === 24 && consistent && nonNeg,
      { n60: b60b.length, n15: b15b.length, sum60: sum(b60b).toFixed(3), sum15: sum(b15b).toFixed(3), qualities: b60b.map((b) => b.quality) },
    );

    // ── (b2) telemetry_hourly path (retention-cutoff branch), in-process ───
    // The REST window cap (31 d) can never cross the 90 d raw-retention
    // cutoff, so exercise the hourly branch directly against the store with
    // TELEMETRY_RAW_DAYS=0 (cutoff = now). Uses today's rolled-up hours.
    process.env.TELEMETRY_RAW_DAYS = "0";
    const { MySqlTelemetryStore } = await import("../api/telemetry/mysql-store");
    const store = new MySqlTelemetryStore();
    // Deterministic window: [now−4h, now) snapped to the settled-hour boundary.
    // The current incomplete hour is excluded entirely — it may merge a live
    // measured raw tail (estimated=false), which is correct store behavior but
    // not what the hourly-expansion property asserts.
    const hourStartMs = Math.floor(Date.now() / hourMs) * hourMs;
    const hRows = await store.energyIntervals(1, new Date(hourStartMs - 4 * hourMs), new Date(hourStartMs), 60);
    const xRows = await store.energyIntervals(1, new Date(hourStartMs - 4 * hourMs), new Date(hourStartMs), 15);
    const sumH = hRows.reduce((s, r) => s + (r.importKwh ?? 0), 0);
    const sumX = xRows.reduce((s, r) => s + (r.importKwh ?? 0), 0);
    probe(
      "(b2) hourly path: rolled-up buckets, sub-hour expansion estimated, totals consistent",
      hRows.length >= 3 && xRows.length >= 12 && xRows.every((r) => r.estimated) && Math.abs(sumH - sumX) < 0.05 && sumH > 1,
      { hours: hRows.map((r) => [new Date(r.bucketStartSec * 1000).toISOString().slice(11, 16), r.importKwh, r.estimated]), sumH: sumH.toFixed(3), sumX: sumX.toFixed(3), expanded: xRows.length },
    );

    // ── (c) 404 ────────────────────────────────────────────────────────────
    const nf = await v1(`/devices/999999999/energy?${q}`, raw);
    probe("(c) unknown device → 404", nf.status === 404 && typeof nf.body?.error === "string", { status: nf.status });

    // ── (d) 400s ───────────────────────────────────────────────────────────
    const long = await v1(`/devices/1/energy?from=${new Date(fromMs - 40 * 86_400_000).toISOString()}&to=${new Date(toMs).toISOString()}&bucketMin=60`, raw);
    const badBucket = await v1(`/devices/1/energy?${q}`.replace("bucketMin=15", "bucketMin=7"), raw);
    const inverted = await v1(`/devices/1/energy?from=${new Date(toMs).toISOString()}&to=${new Date(fromMs).toISOString()}&bucketMin=15`, raw);
    const garbage = await v1(`/devices/1/energy?from=not-a-date&to=${new Date(toMs).toISOString()}&bucketMin=15`, raw);
    probe(
      "(d) 400: range >31d, bucketMin=7, from>=to, unparsable date",
      long.status === 400 && badBucket.status === 400 && inverted.status === 400 && garbage.status === 400,
      { long: long.status, bucket: badBucket.status, inverted: inverted.status, garbage: garbage.status },
    );

    // ── (e) 401 without key ────────────────────────────────────────────────
    const noKey = await v1(`/devices/1/energy?${q}`);
    probe("(e) no key → 401", noKey.status === 401, { status: noKey.status });
  } finally {
    // ── (f) revoke → 401; revocation is the cleanup (no raw key persists) ──
    await trpc("apiKeys.revoke", { id: created.id }, "admin");
    const after = await v1("/devices/1/energy?from=2026-01-01T00:00:00Z&to=2026-01-02T00:00:00Z&bucketMin=60", raw);
    probe("(f) revoked key → 401 immediately", after.status === 401, { status: after.status });
  }

  console.log(fails === 0 ? "=== ALL PASS" : `=== ${fails} FAILURES`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
