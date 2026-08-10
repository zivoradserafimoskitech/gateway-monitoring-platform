// v8/D6 probe: HA.
//  a) GET /healthz → 200 on the dev server; GET /readyz → 200.
//  b) readyz reports db + broker components (embedded-dev mode on :3000).
//  c) SECOND instance: standalone broker on :1884 (scripts/broker.ts,
//     MQTT_PORT=1884) + app on :3100 (NODE_ENV=production, MQTT_URL=mqtt://
//     localhost:1884, own WAL dir, EMS/reports/poller loops off) → readyz 200
//     (external broker mode); a G30 uplink published to :1884 is ingested by
//     the 3100 instance (metrics messages_in + auto-provisioned gateway row).
//  d) second instance + broker killed; dev server on :3000 unaffected.
// Run: npx tsx scripts/probe-v8-ha.ts  (dev server on :3000 must be running)
import "dotenv/config";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../api/queries/connection";
import { gateways, meters } from "../db/schema";

const UID = "gw-ha-probe";
const children: ChildProcess[] = [];
let fails = 0;

function probe(name: string, ok: boolean, detail: unknown): void {
  console.log(ok ? "PASS" : "FAIL", name, "->", JSON.stringify(detail).slice(0, 220));
  if (!ok) fails++;
}

function spawnLogged(name: string, cmd: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
  const fd = fs.openSync(`/tmp/${name}.log`, "w");
  // detached: own process group so teardown kills npx AND the node grandchild.
  const p = spawn(cmd, args, { cwd: process.cwd(), env: { ...process.env, ...env }, stdio: ["ignore", fd, fd], detached: true });
  children.push(p);
  return p;
}

function killTree(p: ChildProcess, sig: "SIGTERM" | "SIGKILL"): void {
  try {
    if (p.pid) process.kill(-p.pid, sig); // whole group
  } catch {
    try { p.kill(sig); } catch { /* already gone */ }
  }
}

async function waitFor(fn: () => Promise<boolean>, timeoutMs: number, step = 500): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, step));
  }
  return false;
}

async function getJson(url: string): Promise<{ status: number; body: Record<string, unknown> | null }> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    return { status: res.status, body: (await res.json().catch(() => null)) as Record<string, unknown> | null };
  } catch {
    return { status: 0, body: null };
  }
}

async function metrics(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  return res.text();
}

function metricValue(text: string, name: string): number {
  const m = text.match(new RegExp(`^${name} (\\d+(?:\\.\\d+)?)$`, "m"));
  return m ? Number(m[1]) : 0;
}

async function main() {
  // ── (a) liveness + readiness on the dev server ───────────────────────────
  const hz = await getJson("http://localhost:3000/healthz");
  const rz = await getJson("http://localhost:3000/readyz");
  probe("(a) /healthz 200 + /readyz 200 on :3000", hz.status === 200 && rz.status === 200, { healthz: hz.status, readyz: rz.status });

  // ── (b) readyz components ────────────────────────────────────────────────
  const comps = (rz.body?.components ?? {}) as Record<string, string>;
  probe(
    "(b) readyz reports db + broker components",
    rz.body?.status === "ready" && comps.db === "ok" && comps.broker === "ok" && typeof comps.brokerMode === "string",
    { status: rz.body?.status, components: comps },
  );

  try {
    // ── (c) second broker + second app instance ────────────────────────────
    spawnLogged("ha-broker2", "npx", ["tsx", "scripts/broker.ts"], { MQTT_EMBEDDED_PORT: "1884", MQTT_TLS: "0" });
    const brokerUp = await waitFor(async () => {
      try {
        const { connect } = await import("mqtt");
        const c = connect("mqtt://127.0.0.1:1884", { connectTimeout: 1500 });
        await new Promise<void>((res, rej) => { c.on("connect", () => res()); c.on("error", rej); });
        c.end(true);
        return true;
      } catch { return false; }
    }, 20_000);
    spawnLogged("ha-app2", "npx", ["tsx", "api/boot.ts"], {
      NODE_ENV: "production",
      PORT: "3100",
      MQTT_URL: "mqtt://localhost:1884",
      TELEMETRY_WAL_DIR: "data/wal-ha-probe",
      EMS_TICK_S: "0",       // loop off (v8/D6 probe switch)
      REPORT_TICK_MIN: "0",  // loop off
      POLLER_ENABLED: "0",   // loop off
      MQTT_SHARED_SUB: "0",  // aedes stand-in broker has no $share support
    });
    const rz2up = await waitFor(async () => (await getJson("http://localhost:3100/readyz")).status === 200, 60_000);
    const rz2 = await getJson("http://localhost:3100/readyz");
    probe(
      "(c) second instance on :3100 ready against EXTERNAL broker :1884",
      brokerUp && rz2up && ((rz2.body?.components as Record<string, string> | undefined)?.brokerMode ?? "") === "external",
      { brokerUp, readyz2: rz2.status, components: rz2.body?.components },
    );

    // Publish one G30 uplink to the external broker; the 3100 instance must ingest it.
    const db = getDb();
    if (rz2up) {
      const { connect } = await import("mqtt");
      const pub = connect("mqtt://127.0.0.1:1884");
      await new Promise<void>((res) => pub.on("connect", () => res()));
      pub.publish(
        `matis/gateway/pVariable/${UID}`,
        JSON.stringify([{ addr: 1, model: "PEM3000", data: { energyImportKwh: 42.5, activePowerKw: 1.1 } }]),
        { qos: 1 },
      );
      await new Promise((r) => setTimeout(r, 1000));
      pub.end(true);

      const ingested = await waitFor(async () => {
        const m = metricValue(await metrics("http://localhost:3100/metrics"), "enertrek_mqtt_messages_in_total");
        return m >= 1;
      }, 15_000);
      const m2 = await metrics("http://localhost:3100/metrics");
      const gwRow = await waitFor(async () => {
        const rows = await db.select({ id: gateways.id }).from(gateways).where(eq(gateways.uid, UID));
        return rows.length > 0;
      }, 10_000);
      probe(
        "(c) external-broker telemetry ingested by :3100 (messages_in ≥ 1, external_broker=1, gateway auto-provisioned)",
        ingested && metricValue(m2, "enertrek_mqtt_external_broker") === 1 && gwRow,
        { in: metricValue(m2, "enertrek_mqtt_messages_in_total"), external: metricValue(m2, "enertrek_mqtt_external_broker"), gwRow },
      );
    }

    // ── (d) teardown second instance + broker; :3000 unaffected ────────────
  } finally {
    for (const p of children) killTree(p, "SIGTERM");
    await new Promise((r) => setTimeout(r, 1500));
    for (const p of children) killTree(p, "SIGKILL");
    fs.rmSync("data/wal-ha-probe", { recursive: true, force: true });
    // Remove the auto-provisioned probe gateway (+ its meters + telemetry).
    const db = getDb();
    const gw = await db.select({ id: gateways.id }).from(gateways).where(eq(gateways.uid, UID));
    if (gw[0]) {
      const mRows = await db.select({ id: meters.id }).from(meters).where(eq(meters.gatewayId, gw[0].id));
      for (const m of mRows) {
        await db.execute(sql`DELETE FROM telemetry WHERE meter_id = ${m.id}`).catch(() => undefined);
      }
      await db.delete(meters).where(eq(meters.gatewayId, gw[0].id)).catch(() => undefined);
      await db.delete(gateways).where(eq(gateways.id, gw[0].id)).catch(() => undefined);
    }
    const hzAfter = await getJson("http://localhost:3000/healthz");
    const rzAfter = await getJson("http://localhost:3000/readyz");
    probe("(d) dev server on :3000 unaffected after killing second instance", hzAfter.status === 200 && rzAfter.status === 200, { healthz: hzAfter.status, readyz: rzAfter.status });
  }

  console.log(fails === 0 ? "=== ALL PASS" : `=== ${fails} FAILURES`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
