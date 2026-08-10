// Standalone development MQTT broker (aedes) on port 1883.
// In production, point gateways and MQTT_URL at your real broker instead.
//
//   npx tsx scripts/broker.ts
import net from "node:net";
import { Aedes } from "aedes";

const port = parseInt(process.env.MQTT_EMBEDDED_PORT || "1883", 10);
// aedes 1.x: async factory is required — new Aedes() yields a broken broker
const aedes = await Aedes.createBroker();

// Security (v4 F-02): anonymous pub/sub is convenient for the local demo but
// anyone on the network can read/inject fleet traffic. Set MQTT_USERNAME /
// MQTT_PASSWORD to require authentication (the app and the simulators read the
// same env vars, so nothing breaks when they share one environment).
const authUser = process.env.MQTT_USERNAME;
if (authUser) {
  const authPass = process.env.MQTT_PASSWORD ?? "";
  aedes.authenticate = (_client, username, password, callback) => {
    const ok = username === authUser && (password?.toString() ?? "") === authPass;
    callback(ok ? null : new Error("invalid credentials"), ok);
  };
  console.log("[broker] authentication ENABLED (MQTT_USERNAME set)");
} else {
  console.warn("[broker] WARNING: anonymous access allowed — set MQTT_USERNAME/MQTT_PASSWORD outside local dev");
}
// Bind host is configurable: default all interfaces (gateways need to reach
// it); use MQTT_BIND_HOST=127.0.0.1 for pure-local setups.
const bindHost = process.env.MQTT_BIND_HOST || "0.0.0.0";
const server = net.createServer(aedes.handle);

server.listen(port, bindHost, () => {
  console.log(`[broker] aedes listening on ${bindHost}:${port}`);
});

// v7/C3: optional TLS listener (mqtts://) for gateway traffic. Active when
// the cert files exist (MQTT_TLS_KEY / MQTT_TLS_CERT, default certs/dev.*)
// unless MQTT_TLS=0. Generate dev certs with scripts/gen-dev-certs.sh; in
// production use real CA-issued certs. Gateways that verify the CA need the
// cert (or its CA) provisioned — self-signed dev certs require
// rejectUnauthorized=false on the client or CA pinning.
import tls from "node:tls";
import fs from "node:fs";

const tlsKeyPath = process.env.MQTT_TLS_KEY || "certs/dev.key";
const tlsCertPath = process.env.MQTT_TLS_CERT || "certs/dev.crt";
const tlsPort = parseInt(process.env.MQTT_TLS_PORT || "8883", 10);
if (process.env.MQTT_TLS !== "0" && fs.existsSync(tlsKeyPath) && fs.existsSync(tlsCertPath)) {
  const tlsServer = tls.createServer(
    { key: fs.readFileSync(tlsKeyPath), cert: fs.readFileSync(tlsCertPath) },
    aedes.handle,
  );
  tlsServer.listen(tlsPort, bindHost, () => {
    console.log(`[broker] aedes TLS listening on ${bindHost}:${tlsPort} (mqtts)`);
  });
} else {
  console.log("[broker] TLS listener disabled (no certs found or MQTT_TLS=0)");
}

aedes.on("client", (c) => console.log(`[broker] client connected: ${c.id}`));
aedes.on("clientDisconnect", (c) => console.log(`[broker] client disconnected: ${c.id}`));
