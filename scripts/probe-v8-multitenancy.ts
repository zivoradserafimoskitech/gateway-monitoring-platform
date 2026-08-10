// v8/D2 probe: multi-tenancy.
//  a) migration backfill: Default Org exists, admin is superadmin, no null org_id.
//  b) superadmin creates Org B + operator user B → B sees 0 sites/meters/gateways;
//     B mutation on a Default-Org device → 403.
//  c) one site + one device reassigned to Org B → B sees exactly those.
//  d) B read of a Default-Org device by id → 404; B mutation on a Default-Org
//     gateway → 403 (read=404, write=403 semantics).
//  e) regression probes: probe-v7-auth.py (12/12), probe-v7-control.ts (9/9),
//     probe-v8-rest-energy.ts (10/10) — superadmin sees everything.
//  f) cleanup: site/device back to Default Org, user B + Org B removed.
// Run: npx tsx scripts/probe-v8-multitenancy.ts  (dev server on :3000)
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../api/queries/connection";
import { meters, orgs, sites, users } from "../db/schema";

const BASE = "http://localhost:3000";
const jars: Record<string, string> = {};
const B_EMAIL = "orgb-op@enertrek.local";

let fails = 0;
function probe(name: string, ok: boolean, detail: unknown): void {
  console.log(ok ? "PASS" : "FAIL", name, "->", JSON.stringify(detail).slice(0, 220));
  if (!ok) fails++;
}

async function trpc(proc: string, payload: unknown, who?: string, method: "POST" | "GET" = "POST"): Promise<unknown> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (who && jars[who]) headers.cookie = jars[who];
  let url = `${BASE}/api/trpc/${proc}?batch=1`;
  const init: RequestInit = { method, headers };
  if (method === "POST") init.body = JSON.stringify({ "0": { json: payload } });
  else url += `&input=${encodeURIComponent(JSON.stringify({ "0": { json: payload ?? null, meta: payload == null ? { values: ["undefined"] } : undefined } }))}`;
  const res = await fetch(url, init);
  const setCookie = res.headers.get("set-cookie");
  if (who && setCookie) jars[who] = setCookie.split(";")[0];
  const body = await res.json();
  const b = Array.isArray(body) ? body[0] : body;
  if (b.error) throw new Error(b.error.json?.message ?? JSON.stringify(b.error));
  return b.result.data.json;
}

function runProbe(cmd: string, args: string[]): { ok: boolean; tail: string } {
  const r = spawnSync(cmd, args, { cwd: process.cwd(), encoding: "utf8", timeout: 300_000 });
  const out = `${r.stdout ?? ""}\n${r.stderr ?? ""}`;
  const tail = out.trim().split("\n").slice(-2).join(" | ").slice(0, 160);
  return { ok: r.status === 0 && /ALL PASS|\d+\/\d+ passed/.test(out), tail };
}

async function main() {
  const db = getDb();
  await trpc("auth.login", { email: "admin@enertrek.local", password: "admin1234" }, "admin");

  // ── (a) backfill ─────────────────────────────────────────────────────────
  const orgRows = await db.select().from(orgs);
  const admin = (await db.select().from(users).where(eq(users.id, 1)))[0];
  const nulls = await db.execute(sql`
    select (select count(*) from users where org_id is null)
         + (select count(*) from sites where org_id is null)
         + (select count(*) from gateways where org_id is null)
         + (select count(*) from meters where org_id is null)
         + (select count(*) from alarm_rules where org_id is null)
         + (select count(*) from api_keys where org_id is null)
         + (select count(*) from ems_schedules where org_id is null)
         + (select count(*) from ems_peak_shaving where org_id is null)
         + (select count(*) from report_schedules where org_id is null)
         + (select count(*) from ota_jobs where org_id is null) as n`);
  probe(
    "(a) backfill: Default Org, admin superadmin, zero null org_id rows",
    orgRows.some((o) => o.name === "Default Org") && admin?.isSuperadmin === true && Number((nulls[0] as unknown as Array<{ n: number }>)[0].n) === 0,
    { orgs: orgRows.map((o) => o.name), super: admin?.isSuperadmin, nulls: (nulls[0] as unknown as Array<{ n: number }>)[0].n },
  );
  const defaultOrgId = orgRows.find((o) => o.name === "Default Org")!.id;

  let orgBId = 0;
  let userBId = 0;
  const reassigned = { siteId: 1, meterId: 1 }; // site 1 is the only site in the dev DB
  try {
    // ── (b) Org B + user B sees nothing ────────────────────────────────────
    const ob = (await trpc("orgs.create", { name: "Org B" }, "admin")) as { id: number };
    orgBId = ob.id;
    const ub = (await trpc("auth.createUser", { email: B_EMAIL, name: "Org B Op", password: "orgb1234", role: "operator", orgId: orgBId }, "admin")) as { id: number };
    userBId = ub.id;
    await trpc("auth.login", { email: B_EMAIL, password: "orgb1234" }, "b");
    const bSites = (await trpc("sites.list", null, "b", "GET")) as unknown[];
    const bMeters = (await trpc("meters.list", null, "b", "GET")) as unknown[];
    const bGws = (await trpc("gateways.list", null, "b", "GET")) as unknown[];
    let deniedB = "";
    try {
      await trpc("meters.update", { id: reassigned.meterId, name: "hijack" }, "b");
    } catch (e) {
      deniedB = (e as Error).message;
    }
    probe(
      "(b) Org B sees 0 sites/meters/gateways; mutation on Default-Org device → 403",
      orgBId > 0 && userBId > 0 && bSites.length === 0 && bMeters.length === 0 && bGws.length === 0 && /another organization/.test(deniedB),
      { sites: bSites.length, meters: bMeters.length, gws: bGws.length, denied: deniedB },
    );

    // ── (c) reassign site 2 + meter 1 to Org B ─────────────────────────────
    await db.update(sites).set({ orgId: orgBId }).where(eq(sites.id, reassigned.siteId));
    await db.update(meters).set({ orgId: orgBId }).where(eq(meters.id, reassigned.meterId));
    const bSites2 = (await trpc("sites.list", null, "b", "GET")) as Array<{ id: number }>;
    const bMeters2 = (await trpc("meters.list", null, "b", "GET")) as Array<{ id: number }>;
    const bLatest = await trpc("meters.latest", { meterId: reassigned.meterId }, "b", "GET").catch((e) => ({ err: (e as Error).message }));
    probe(
      "(c) B now sees exactly the reassigned site + device (latest readable)",
      bSites2.length === 1 && bSites2[0].id === reassigned.siteId && bMeters2.length === 1 && bMeters2[0].id === reassigned.meterId && !("err" in (bLatest as object)),
      { sites: bSites2.map((s) => s.id), meters: bMeters2.map((m) => m.id) },
    );

    // ── (d) cross-org by id: read 404, write 403 ───────────────────────────
    let readErr = "";
    try {
      await trpc("meters.latest", { meterId: 30013 }, "b", "GET");
    } catch (e) {
      readErr = (e as Error).message;
    }
    let writeErr = "";
    try {
      await trpc("gateways.update", { id: 1, name: "hijack" }, "b");
    } catch (e) {
      writeErr = (e as Error).message;
    }
    probe(
      "(d) B: Default-Org read by id → 404 'not found'; write → 403 'another organization'",
      /not found/i.test(readErr) && /another organization/.test(writeErr),
      { readErr, writeErr },
    );

    // superadmin still sees everything (transparency)
    const aMeters = (await trpc("meters.list", null, "admin", "GET")) as unknown[];
    probe("(d) superadmin transparency: admin sees the full fleet", aMeters.length >= 10, { meters: aMeters.length });

    // Reassign back to Default Org BEFORE the regression probes — the REST
    // energy probe's key (Default Org) must see meter 1 again.
    await db.update(sites).set({ orgId: defaultOrgId }).where(eq(sites.id, reassigned.siteId));
    await db.update(meters).set({ orgId: defaultOrgId }).where(eq(meters.id, reassigned.meterId));

    // ── (e) regression probes (all run as superadmin) ──────────────────────
    const r1 = runProbe("python3", ["scripts/probe-v7-auth.py"]);
    probe("(e) probe-v7-auth.py 12/12", r1.ok, r1.tail);
    const r2 = runProbe("npx", ["tsx", "scripts/probe-v7-control.ts"]);
    probe("(e) probe-v7-control.ts 9/9", r2.ok, r2.tail);
    const r3 = runProbe("npx", ["tsx", "scripts/probe-v8-rest-energy.ts"]);
    probe("(e) probe-v8-rest-energy.ts 10/10", r3.ok, r3.tail);
  } finally {
    // ── (f) cleanup ────────────────────────────────────────────────────────
    await db.update(sites).set({ orgId: defaultOrgId }).where(eq(sites.id, reassigned.siteId)).catch(() => undefined);
    await db.update(meters).set({ orgId: defaultOrgId }).where(eq(meters.id, reassigned.meterId)).catch(() => undefined);
    if (userBId) await db.delete(users).where(eq(users.id, userBId)).catch(() => undefined);
    if (orgBId) await db.delete(orgs).where(eq(orgs.id, orgBId)).catch(() => undefined);
    const leftS = (await db.select().from(sites).where(eq(sites.id, reassigned.siteId)))[0];
    const leftM = (await db.select().from(meters).where(eq(meters.id, reassigned.meterId)))[0];
    const userLeft = await db.select({ id: users.id }).from(users).where(eq(users.email, B_EMAIL));
    const orgLeft = await db.select({ id: orgs.id }).from(orgs).where(eq(orgs.name, "Org B"));
    probe(
      "(f) cleanup: site/device back in Default Org, user B + Org B removed",
      leftS?.orgId === defaultOrgId && leftM?.orgId === defaultOrgId && userLeft.length === 0 && orgLeft.length === 0,
      { siteOrg: leftS?.orgId, meterOrg: leftM?.orgId, defaultOrgId },
    );
  }

  console.log(fails === 0 ? "=== ALL PASS" : `=== ${fails} FAILURES`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
