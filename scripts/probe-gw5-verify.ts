// probe-gw5-verify.ts — Wave 5 live smoke: draft-block gate + override WARNING
// against the real API (dev server on :3000), plus CSV export→import round-trip.
// Creates a temporary meter on model sunspec-inverter-103 (draft, controllable
// activePowerLimitPct) pointed at the pv-sim; asserts:
//   (1) control.execute on the DRAFT profile is rejected with "unverified"
//   (2) with allowUnverifiedControl set, the write proceeds and the command
//       row carries the WARNING marker
//   (3) cleanup restores the profile to plain draft and removes the meter
//   (4) exportCsv → importCsv round-trip lands as draft with sourceDocument
// Usage: npx tsx scripts/probe-gw5-verify.ts
import "dotenv/config";

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const jars: Record<string, string> = {};

const QUERIES = new Set(["profiles.list"]);

async function trpc(proc: string, payload: unknown, who?: string): Promise<any> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (who && jars[who]) headers.cookie = jars[who];
  const isQuery = QUERIES.has(proc);
  const url = `${BASE}/api/trpc/${proc}?batch=1` + (isQuery ? `&input=${encodeURIComponent(JSON.stringify({ 0: { json: payload ?? null } }))}` : "");
  const res = await fetch(url, isQuery
    ? { method: "GET", headers }
    : { method: "POST", headers, body: JSON.stringify({ 0: { json: payload } }) });
  const setCookie = res.headers.get("set-cookie");
  if (who && setCookie) jars[who] = setCookie.split(";")[0];
  const body = await res.json();
  const item = body?.[0];
  if (item?.error) {
    const msg = item.error?.json?.message ?? item.error?.message ?? JSON.stringify(item.error);
    const e = new Error(msg) as any;
    e.code = item.error?.json?.code;
    throw e;
  }
  return item?.result?.data?.json ?? item?.result?.data ?? item?.result;
}

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : " -> " + JSON.stringify(detail)}`);
  if (!ok) failures++;
}

async function main() {
  await trpc("auth.login", { email: "admin@enertrek.local", password: "admin1234" }, "admin");

  // Temp meter on the DRAFT sunspec-inverter-103 profile (controllable key
  // activePowerLimitPct exists on this profile; target = pv-sim, though the
  // gate must fire before any bus traffic anyway).
  const meter = (await trpc(
    "meters.create",
    { name: "gw5-verify-probe", model: "sunspec-inverter-103", deviceType: "inverter", host: "127.0.0.1", port: 5021, unitId: 99 },
    "admin",
  )) as { id: number };

  try {
    // (1) draft → blocked
    let blockedMsg = "";
    try {
      await trpc("control.execute", { meterId: meter.id, key: "activePowerLimitPct", value: 50 }, "admin");
    } catch (e: any) {
      blockedMsg = e.message;
    }
    check("(1) draft profile → control.execute rejected with 'unverified'", /unverified/i.test(blockedMsg), blockedMsg);

    // rejected attempt audited
    const prof = (await trpc("profiles.list", undefined, "admin")) as any[];
    const p103 = prof.find((p) => p.model === "sunspec-inverter-103");
    check("(1b) sunspec-inverter-103 is draft with no override", p103?.verificationStatus === "draft" && !p103?.allowUnverifiedControl, { s: p103?.verificationStatus });

    // (2) override on → proceeds with WARNING marker
    await trpc("profiles.updateVerification", { id: p103.id, allowUnverifiedControl: true }, "admin");
    let okResult: any = null;
    try {
      okResult = await trpc("control.execute", { meterId: meter.id, key: "activePowerLimitPct", value: 50 }, "admin");
    } catch (e: any) {
      okResult = { error: e.message };
    }
    const detail = okResult?.detail ?? okResult?.result ?? okResult?.error ?? "";
    check("(2) override → write attempted, WARNING marker present", /WARNING: commissioning override/.test(String(detail)), detail);
  } finally {
    // (3) cleanup: clear override + delete temp meter (each step best-effort)
    try {
      const prof = (await trpc("profiles.list", undefined, "admin")) as any[];
      const p103 = prof.find((p) => p.model === "sunspec-inverter-103");
      if (p103) await trpc("profiles.updateVerification", { id: p103.id, allowUnverifiedControl: false }, "admin");
    } catch { /* cleanup best-effort */ }
    await trpc("meters.remove", { id: meter.id }, "admin").catch(() => undefined);
    const after = (await trpc("profiles.list", undefined, "admin")) as any[];
    const pAfter = after.find((p) => p.model === "sunspec-inverter-103");
    check("(3) cleanup: override cleared, profile draft", pAfter?.verificationStatus === "draft" && !pAfter?.allowUnverifiedControl, { s: pAfter?.verificationStatus, o: pAfter?.allowUnverifiedControl });
  }

  // (4) export → import round-trip
  const exp = (await trpc("profiles.exportCsv", { id: profId(await trpc("profiles.list", undefined, "admin"), "sunspec-inverter-103") }, "admin")) as { filename: string; csv: string };
  check("(4a) exportCsv returns canonical header", exp.csv.startsWith("key,address,fc,type,scale,unit,writable,min,max,description"), exp.csv.slice(0, 60));
  const imp = (await trpc(
    "profiles.importCsv",
    { csv: exp.csv, model: "sunspec-inverter-103-gw5copy", label: "gw5 round-trip copy", sourceDocument: "round-trip probe of sunspec-inverter-103 export (self-citing)", deviceType: "inverter" },
    "admin",
  )) as any;
  const list2 = (await trpc("profiles.list", undefined, "admin")) as any[];
  const copy = list2.find((p) => p.model === "sunspec-inverter-103-gw5copy");
  check("(4b) import lands as draft with sourceDocument", copy?.verificationStatus === "draft" && !!copy?.sourceDocument, { s: copy?.verificationStatus });
  // import without sourceDocument must be rejected
  let noSrc = "";
  try {
    await trpc("profiles.importCsv", { csv: exp.csv, model: "gw5-nosrc", label: "x", sourceDocument: "   " }, "admin");
  } catch (e: any) {
    noSrc = e.message;
  }
  check("(4c) import without sourceDocument rejected", noSrc.length > 0, noSrc);
  if (copy) await trpc("profiles.remove", { id: copy.id }, "admin").catch(() => undefined);

  console.log(failures === 0 ? "=== ALL PASS" : `=== ${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

function profId(list: any[], model: string): number {
  const p = list.find((x) => x.model === model);
  if (!p) throw new Error(`profile ${model} not found`);
  return p.id;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
