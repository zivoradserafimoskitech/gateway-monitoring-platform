// Standalone development MQTT broker (aedes) on port 1883.
// In production, point gateways and MQTT_URL at your real broker instead.
//
//   npx tsx scripts/broker.ts
import net from "node:net";
import { Aedes } from "aedes";

const port = parseInt(process.env.MQTT_EMBEDDED_PORT || "1883", 10);
// aedes 1.x: async factory is required — new Aedes() yields a broken broker
const aedes = await Aedes.createBroker();
const server = net.createServer(aedes.handle);

server.listen(port, () => {
  console.log(`[broker] aedes listening on :${port}`);
});

aedes.on("client", (c) => console.log(`[broker] client connected: ${c.id}`));
aedes.on("clientDisconnect", (c) => console.log(`[broker] client disconnected: ${c.id}`));
