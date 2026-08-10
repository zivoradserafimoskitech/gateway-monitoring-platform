// v7/C3 probe: TLS for the MQTT broker.
//  1. gen-dev-certs.sh produces a key/cert pair.
//  2. Broker (child process) starts a TLS listener on 8883 alongside 1883.
//  3. mqtts client with rejectUnauthorized=false connects + pub/sub roundtrip.
//  4. mqtts client that TRUSTS the cert as CA connects strictly.
//  5. mqtts client with default trust (no CA) is REJECTED (self-signed).
//  6. Plaintext 1883 still works (gateways without TLS keep functioning).
import "dotenv/config";
import fs from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import mqtt from "mqtt";

const PLAIN_PORT = 18885;
const TLS_PORT = 18886;

function tryConnect(url: string, opts: mqtt.IClientOptions): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const c = mqtt.connect(url, { ...opts, reconnectPeriod: 0, connectTimeout: 4000 });
    const to = setTimeout(() => { c.end(true); resolve({ ok: false, error: "timeout" }); }, 6000);
    c.on("connect", () => { clearTimeout(to); c.end(true); resolve({ ok: true }); });
    c.on("error", (e) => { clearTimeout(to); c.end(true); resolve({ ok: false, error: e.message }); });
  });
}

async function main() {
  let fails = 0;
  const probe = (n: string, ok: boolean, d: unknown) => {
    console.log(ok ? "PASS" : "FAIL", n, "->", JSON.stringify(d).slice(0, 200));
    if (!ok) fails++;
  };

  execFileSync("bash", ["scripts/gen-dev-certs.sh", "certs", "localhost"], { stdio: "pipe" });
  probe("gen-dev-certs.sh produced certs/dev.key + certs/dev.crt", fs.existsSync("certs/dev.key") && fs.existsSync("certs/dev.crt"), null);

  const child = spawn("npx", ["tsx", "scripts/broker.ts"], {
    env: { ...process.env, MQTT_EMBEDDED_PORT: String(PLAIN_PORT), MQTT_TLS_PORT: String(TLS_PORT), MQTT_BIND_HOST: "127.0.0.1" },
    stdio: "pipe",
  });
  let brokerLog = "";
  child.stdout.on("data", (d) => (brokerLog += d));
  child.stderr.on("data", (d) => (brokerLog += d));
  await new Promise((r) => setTimeout(r, 5000));
  probe("broker reports TLS listener", brokerLog.includes(`TLS listening on 127.0.0.1:${TLS_PORT}`), brokerLog.split("\n").filter((l) => l.includes("listening")));

  const insecure = await tryConnect(`mqtts://localhost:${TLS_PORT}`, { rejectUnauthorized: false });
  probe("mqtts connect (rejectUnauthorized=false)", insecure.ok, insecure);

  const strictWithCa = await tryConnect(`mqtts://localhost:${TLS_PORT}`, { ca: fs.readFileSync("certs/dev.crt") });
  probe("mqtts connect with pinned CA (strict)", strictWithCa.ok, strictWithCa);

  const strictNoCa = await tryConnect(`mqtts://localhost:${TLS_PORT}`, {});
  probe("mqtts connect without CA is rejected (self-signed)", !strictNoCa.ok, strictNoCa);

  // pub/sub roundtrip over TLS
  const roundtrip = await new Promise<boolean>((resolve) => {
    const sub = mqtt.connect(`mqtts://localhost:${TLS_PORT}`, { rejectUnauthorized: false, reconnectPeriod: 0 });
    const to = setTimeout(() => resolve(false), 8000);
    sub.on("connect", () => {
      sub.subscribe("probe/tls", () => {
        const pub = mqtt.connect(`mqtts://localhost:${TLS_PORT}`, { rejectUnauthorized: false, reconnectPeriod: 0 });
        pub.on("connect", () => pub.publish("probe/tls", "hello-tls", () => pub.end()));
      });
    });
    sub.on("message", (_t, payload) => {
      clearTimeout(to);
      sub.end();
      resolve(payload.toString() === "hello-tls");
    });
  });
  probe("pub/sub roundtrip over mqtts", roundtrip, null);

  const plain = await tryConnect(`mqtt://localhost:${PLAIN_PORT}`, {});
  probe("plaintext listener still works", plain.ok, plain);

  child.kill("SIGTERM");
  console.log(fails === 0 ? "=== ALL PASS" : `=== ${fails} FAILURES`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
