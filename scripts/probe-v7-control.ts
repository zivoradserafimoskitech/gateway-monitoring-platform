// v7/C12 probe: active control.
//  1. Whitelist config: huawei-sun2000 gets a controllable setpoint register.
//  2. admin executes 55.5 % → FC6 write + read-back OK; sim register == 555
//     (verified by an independent Modbus read from the probe itself).
//  3. Out-of-range (150) → BAD_REQUEST, logged as rejected command.
//  4. Non-whitelisted key → rejected.
//  5. Viewer role → FORBIDDEN before any bus traffic.
//  6. Offline device → status "failed" (ECONNREFUSED), command row logged.
//  7. Audit log contains the control.execute mutations.
import "dotenv/config";
import { eq, desc } from "drizzle-orm";
import ModbusRTU from "modbus-serial";
import { getDb } from "../api/queries/connection";
import { auditLog, commands, deviceProfiles, gateways, meters, users } from "../db/schema";

const BASE = "http://localhost:3000";
const jars: Record<string, string> = {};

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
  if (b.error) {
    const err = new Error(b.error.json?.message ?? b.error.message ?? JSON.stringify(b.error)) as Error & { code?: string; httpStatus?: number };
    err.code = b.error.json?.data?.code ?? b.error.data?.code;
    err.httpStatus = res.status;
    throw err;
  }
  return b.result.data.json;
}

async function main() {
  const db = getDb();
  let fails = 0;
  const probe = (n: string, ok: boolean, d: unknown) => {
    console.log(ok ? "PASS" : "FAIL", n, "->", JSON.stringify(d).slice(0, 240));
    if (!ok) fails++;
  };

  // logins
  await trpc("auth.login", { email: "admin@enertrek.local", password: "admin1234" }, "admin");
  const viewerEmail = "c12-viewer@enertrek.local";
  const existing = await db.select().from(users).where(eq(users.email, viewerEmail));
  if (existing.length === 0) {
    await trpc("auth.createUser", { email: viewerEmail, name: "C12 Viewer", password: "viewer1234", role: "viewer" }, "admin");
  }
  await trpc("auth.login", { email: viewerEmail, password: "viewer1234" }, "viewer");

  // 1. whitelist
  await db
    .update(deviceProfiles)
    .set({
      controllable: {
        activePowerLimitPct: { address: 40100, fc: 6, min: 0, max: 100, scale: 10, unit: "%", description: "Active power limit" },
      },
    })
    .where(eq(deviceProfiles.model, "huawei-sun2000"));
  const wl = (await trpc("control.controllableFor", { meterId: 30013 }, "admin", "GET")) as Record<string, { min: number; max: number }>;
  probe("whitelist visible via control.controllableFor", wl.activePowerLimitPct?.max === 100, Object.keys(wl));

  // 2. execute as admin
  const r1 = (await trpc("control.execute", { meterId: 30013, key: "activePowerLimitPct", value: 55.5 }, "admin")) as { status: string; detail: string };
  probe("execute 55.5% → ok + read-back verified", r1.status === "ok" && r1.detail.includes("verified"), r1);

  // independent read from the simulator
  const client = new ModbusRTU();
  await client.connectTCP("127.0.0.1", { port: 5021 });
  client.setID(1);
  client.setTimeout(5000);
  const reg = await client.readHoldingRegisters(40100, 1);
  await client.close(() => undefined);
  probe("simulator register 40100 == 555 (independent read)", reg.data?.[0] === 555, reg.data);

  // 3. out of range
  let oor = "";
  try {
    await trpc("control.execute", { meterId: 30013, key: "activePowerLimitPct", value: 150 }, "admin");
  } catch (e) {
    oor = (e as Error).message;
  }
  probe("out-of-range 150 → BAD_REQUEST", oor.includes("out of range"), oor);

  // 4. non-whitelisted key
  let nw = "";
  try {
    await trpc("control.execute", { meterId: 30013, key: "rebootDevice", value: 1 }, "admin");
  } catch (e) {
    nw = (e as Error).message;
  }
  probe("non-whitelisted key → rejected", nw.includes("not controllable"), nw);

  // 5. viewer forbidden
  let fb = "";
  let fbStatus = 0;
  try {
    await trpc("control.execute", { meterId: 30013, key: "activePowerLimitPct", value: 10 }, "viewer");
  } catch (e) {
    fb = (e as Error).message;
    fbStatus = (e as { httpStatus?: number }).httpStatus ?? 0;
  }
  probe("viewer → FORBIDDEN (no bus traffic)", fb.includes("Requires role") || fbStatus === 403, { fb, fbStatus });

  // 6. offline device → failed + logged
  const g = await db.insert(gateways).values({ uid: "gw-c12-probe", name: "c12", model: "TCP", transport: "tcp", topicPrefix: "-" }).$returningId();
  const m = await db.insert(meters).values({ gatewayId: g[0].id, name: "c12 offline", model: "huawei-sun2000", modbusAddress: 9, host: "127.0.0.1", port: 5999, unitId: 9 }).$returningId();
  const deadId = m[0].id;
  const r2 = (await trpc("control.execute", { meterId: deadId, key: "activePowerLimitPct", value: 50 }, "admin")) as { status: string; detail: string };
  probe("offline device → status failed (connection refused)", r2.status === "failed" && /refused|ECONNREFUSED|timed out/i.test(r2.detail), r2);

  // 7. command + audit trail
  const cmds = await db.select().from(commands).where(eq(commands.meterId, 30013)).orderBy(desc(commands.createdAt)).limit(10);
  const kinds = cmds.filter((c) => c.kind === "control").map((c) => [c.controlKey, c.controlValue, c.status, c.userId]);
  const deadCmds = await db.select().from(commands).where(eq(commands.meterId, deadId));
  probe(
    "commands trail: ok + 2 rejected logged with userId",
    kinds.some((k) => k[2] === "ok" && k[3] === 1) && kinds.filter((k) => k[2] === "failed").length >= 2 && deadCmds.some((c) => c.status === "failed" && c.userId === 1),
    { kinds: kinds.slice(0, 4), dead: deadCmds.map((c) => [c.controlKey, c.status]) },
  );
  const audit = await db.select().from(auditLog).where(eq(auditLog.procedure, "control.execute")).orderBy(desc(auditLog.createdAt)).limit(8);
  probe(
    "audit log: successes, FAILED rejections AND viewer DENIED all audited",
    audit.length >= 5 && audit.some((a) => (a.summary ?? "").startsWith("DENIED(FORBIDDEN)")) && audit.some((a) => (a.summary ?? "").startsWith("FAILED(")),
    audit.map((a) => a.summary).slice(0, 5),
  );

  // cleanup
  await db.delete(commands).where(eq(commands.meterId, deadId));
  await db.delete(meters).where(eq(meters.id, deadId));
  await db.delete(gateways).where(eq(gateways.id, g[0].id));
  console.log(fails === 0 ? "=== ALL PASS" : `=== ${fails} FAILURES`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
