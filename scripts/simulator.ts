// Virtual Enertrek gateway simulator — test the whole pipeline
// (MQTT ingestion → storage → dashboards/alarms/reports) without hardware.
//
// Demo mode (default):
//   • one G30 gateway (uid 17697439880) publishing JSON every 5 s
//       topic: matis/gateway/pVariable/17697439880
//       meters: PEM3000 @ addr 1, SEM3250 @ addr 2
//   • one C30 gateway (uid 867156067806820) publishing raw Modbus RTU frames every 10 s
//       topic: d2g/867156067806820   (meter: PEM3000 @ addr 1)
//       answers on-demand reads on   g2d/867156067806820
//
// Scale mode (load testing):
//   npx tsx scripts/simulator.ts --scale --gateways 500 --meters 16 --interval 15000 --duration 180
//   → 70% G30 (1 JSON batch msg per gateway per interval)
//   → 30% C30 (1 Modbus frame per meter per interval)
//   Synthetic UIDs: G30 170XXXXXXXXXXXX / C30 860XXXXXXXXXXXX — easy to clean up.
//
// Other:
//   npx tsx scripts/simulator.ts --backfill         # live demo + insert 7 days of history
//   npx tsx scripts/simulator.ts --backfill-only    # only insert history, then exit
import "dotenv/config";
import mqtt from "mqtt";
import { DEFAULT_REGISTER_MAPS } from "../contracts/modbus";
import { buildReadRequest, crc16 } from "../api/modbus";

const BROKER = process.env.SIM_MQTT_URL || "mqtt://127.0.0.1:1883";
const G30_UID = "17697439880";
const C30_UID = "867156067806820";
const BACKFILL = process.argv.includes("--backfill") || process.argv.includes("--backfill-only");
const BACKFILL_ONLY = process.argv.includes("--backfill-only");
const SCALE = process.argv.includes("--scale");

function numArg(flag: string, def: number): number {
  const i = process.argv.indexOf(flag);
  return i >= 0 && process.argv[i + 1] ? parseInt(process.argv[i + 1], 10) : def;
}

// Energy counters (kWh), persist across ticks
const counters = new Map<string, number>([
  [`${G30_UID}:1`, 18234.5],
  [`${G30_UID}:2`, 9871.2],
  [`${C30_UID}:1`, 24081.9],
]);

function dayLoadFactor(date: Date): number {
  const h = date.getHours() + date.getMinutes() / 60;
  if (h < 5) return 0.25;
  if (h < 7) return 0.25 + ((h - 5) / 2) * 0.45;
  if (h < 16) return 0.7 + 0.25 * Math.sin(((h - 7) / 9) * Math.PI);
  if (h < 22) return 0.7 - ((h - 16) / 6) * 0.45;
  return 0.25;
}

function noise(amp: number): number {
  return (Math.random() - 0.5) * 2 * amp;
}

interface LiveReading {
  U1: number; U2: number; U3: number;
  I1: number; I2: number; I3: number;
  P: number; Q: number; S: number; PF: number; F: number;
  Ep: number; EpExp: number; Dmd: number;
}

function genReading(key: string, baseKw: number, intervalHours: number, at: Date): LiveReading {
  const pf = 0.93 + Math.random() * 0.06;
  const p = Math.max(2, baseKw * dayLoadFactor(at) * (1 + noise(0.08)));
  const s = p / pf;
  const q = Math.sqrt(Math.max(0, s * s - p * p));
  const iTotal = (p * 1000) / (Math.sqrt(3) * 400);
  const energy = counters.get(key) ?? 10000;
  const next = energy + p * intervalHours;
  counters.set(key, next);
  return {
    U1: 230.4 + noise(1.2),
    U2: 231.1 + noise(1.2),
    U3: 229.8 + noise(1.2),
    I1: iTotal * (1 + noise(0.03)),
    I2: iTotal * (1 + noise(0.03)),
    I3: iTotal * (1 + noise(0.03)),
    P: p, Q: q, S: s, PF: pf, F: 50 + noise(0.03),
    Ep: next, EpExp: 0, Dmd: p * (1 + Math.random() * 0.1),
  };
}

const r2 = (n: number) => Math.round(n * 100) / 100;

// ─── C30 Modbus frame builder (float32 ABCD, FC04, span from register map) ──
function buildC30Response(slave: number, start: number, quantity: number, reading: LiveReading): Buffer {
  const map = DEFAULT_REGISTER_MAPS.PEM3000;
  const data = Buffer.alloc(quantity * 2);
  // Engineering units here; the register map's scale converts them to wire values
  const values: Record<string, number> = {
    voltageL1: reading.U1, voltageL2: reading.U2, voltageL3: reading.U3,
    currentL1: reading.I1, currentL2: reading.I2, currentL3: reading.I3,
    activePowerKw: reading.P,
    reactivePowerKvar: reading.Q,
    apparentPowerKva: reading.S,
    powerFactor: reading.PF,
    frequencyHz: reading.F,
    energyImportKwh: reading.Ep,
    energyExportKwh: reading.EpExp,
    demandKw: reading.Dmd,
  };
  for (const def of map) {
    const offset = (def.address - start) * 2;
    if (offset < 0 || offset + 4 > data.length) continue;
    const raw = values[def.key];
    if (raw === undefined) continue;
    data.writeFloatBE(raw / def.scale, offset);
  }
  const body = Buffer.alloc(3 + data.length);
  body.writeUInt8(slave, 0);
  body.writeUInt8(4, 1);
  body.writeUInt8(data.length, 2);
  data.copy(body, 3);
  const frame = Buffer.alloc(body.length + 2);
  body.copy(frame, 0);
  frame.writeUInt16LE(crc16(body), body.length);
  return frame;
}

// ─── Backfill: 7 days of hourly history straight into the DB (demo gateways) ─
async function backfill() {
  const { getDb } = await import("../api/queries/connection");
  const { gateways, meters, telemetry } = await import("../db/schema");
  const { eq, and, sql } = await import("drizzle-orm");
  const db = getDb();

  const pairs: Array<{ uid: string; model: "G30" | "C30"; slaves: Array<{ addr: number; model: "SEM2250" | "SEM3250" | "PEM3000"; baseKw: number }> }> = [
    {
      uid: G30_UID,
      model: "G30",
      slaves: [
        { addr: 1, model: "PEM3000", baseKw: 60 },
        { addr: 2, model: "SEM3250", baseKw: 25 },
      ],
    },
    { uid: C30_UID, model: "C30", slaves: [{ addr: 1, model: "PEM3000", baseKw: 40 }] },
  ];

  for (const p of pairs) {
    const gwRows = await db.select().from(gateways).where(eq(gateways.uid, p.uid)).limit(1);
    const gw = gwRows[0];
    if (!gw) {
      console.log(`[sim] backfill: gateway ${p.uid} not yet provisioned — run live first`);
      continue;
    }
    for (const s of p.slaves) {
      const mRows = await db
        .select()
        .from(meters)
        .where(and(eq(meters.gatewayId, gw.id), eq(meters.modbusAddress, s.addr)))
        .limit(1);
      const meter = mRows[0];
      if (!meter) continue;
      const count = await db
        .select({ n: sql<number>`count(*)` })
        .from(telemetry)
        .where(eq(telemetry.meterId, meter.id));
      if (Number(count[0].n) > 500) {
        console.log(`[sim] backfill: meter ${meter.id} already has history, skipping`);
        continue;
      }
      const key = `${p.uid}:${s.addr}`;
      const liveBase = counters.get(key) ?? 10000;
      counters.set(key, liveBase - 7 * 24 * s.baseKw * 0.5);
      const rows = [];
      for (let i = 7 * 24; i >= 1; i--) {
        const at = new Date(Date.now() - i * 3600_000);
        const r = genReading(key, s.baseKw, 1, at);
        rows.push({
          meterId: meter.id,
          ts: at,
          voltageL1: r2(r.U1), voltageL2: r2(r.U2), voltageL3: r2(r.U3),
          currentL1: r2(r.I1), currentL2: r2(r.I2), currentL3: r2(r.I3),
          activePowerKw: r2(r.P), reactivePowerKvar: r2(r.Q), apparentPowerKva: r2(r.S),
          powerFactor: Math.round(r.PF * 1000) / 1000,
          frequencyHz: r2(r.F),
          energyImportKwh: r2(r.Ep), energyExportKwh: 0, demandKw: r2(r.Dmd),
        });
      }
      const shift = liveBase - rows[rows.length - 1].energyImportKwh;
      for (const row of rows) row.energyImportKwh = r2(row.energyImportKwh + shift);
      await db.insert(telemetry).values(rows);
      console.log(`[sim] backfill: inserted ${rows.length} rows for meter ${meter.id}`);
    }
  }
}

// ─── Scale mode ──────────────────────────────────────────────────────────────
interface VirtualGateway {
  uid: string;
  model: "G30" | "C30";
  meters: Array<{ addr: number; baseKw: number }>;
}

function makeFleet(count: number, metersPer: number): VirtualGateway[] {
  const fleet: VirtualGateway[] = [];
  for (let i = 0; i < count; i++) {
    const isC30 = i % 10 < 3; // 30% C30
    const uid = isC30
      ? `860${String(i).padStart(12, "0")}`
      : `170${String(i).padStart(12, "0")}`;
    const meters = Array.from({ length: metersPer }, (_, a) => ({
      addr: a + 1,
      baseKw: 20 + ((i * 7 + a * 13) % 60), // deterministic variety: 20–80 kW
    }));
    fleet.push({ uid, model: isC30 ? "C30" : "G30", meters });
  }
  return fleet;
}

async function runScale(gatewayCount: number, metersPer: number, intervalMs: number, durationSec: number) {
  const fleet = makeFleet(gatewayCount, metersPer);
  const totalMeters = fleet.reduce((s, g) => s + g.meters.length, 0);
  console.log(
    `[sim] SCALE MODE: ${gatewayCount} gateways × ${metersPer} meters = ${totalMeters} meters, ` +
      `interval ${intervalMs} ms (~${Math.round(totalMeters / (intervalMs / 1000))} samples/s)`,
  );

  const client = mqtt.connect(BROKER, { clientId: `enertrek-scale-${Date.now()}`, username: process.env.MQTT_USERNAME || undefined, password: process.env.MQTT_PASSWORD || undefined });
  let published = 0;
  const started = Date.now();

  client.on("connect", () => {
    console.log(`[sim] connected to ${BROKER}`);
    fleet.forEach((gw, gi) => {
      // Stagger starts to avoid a thundering herd
      setTimeout(() => {
        const timer = setInterval(() => {
          const now = new Date();
          if (gw.model === "G30") {
            const payload = gw.meters.map((m) => ({
              addr: m.addr,
              model: "PEM3000",
              data: genReading(`${gw.uid}:${m.addr}`, m.baseKw, intervalMs / 3600_000, now),
            }));
            client.publish(`matis/gateway/pVariable/${gw.uid}`, JSON.stringify(payload));
            published += gw.meters.length;
          } else {
            for (const m of gw.meters) {
              const reading = genReading(`${gw.uid}:${m.addr}`, m.baseKw, intervalMs / 3600_000, now);
              client.publish(`d2g/${gw.uid}`, buildC30Response(m.addr, 0x0000, 0x56, reading));
              published++;
            }
          }
        }, intervalMs);
        timer.unref?.();
      }, (gi * 97) % intervalMs);
    });

    if (durationSec > 0) {
      const report = setInterval(() => {
        const elapsed = (Date.now() - started) / 1000;
        console.log(`[sim] ${elapsed.toFixed(0)}s elapsed — published ${published} samples (${Math.round(published / elapsed)}/s)`);
      }, 15000);
      setTimeout(() => {
        clearInterval(report);
        const elapsed = (Date.now() - started) / 1000;
        console.log(`[sim] DONE: ${published} samples in ${elapsed.toFixed(0)}s (${Math.round(published / elapsed)}/s avg)`);
        client.end();
        process.exit(0);
      }, durationSec * 1000);
    }
  });

  client.on("error", (e) => console.error("[sim] mqtt error:", e.message));
}

// ─── Demo mode ───────────────────────────────────────────────────────────────
async function main() {
  if (BACKFILL_ONLY) {
    await backfill();
    console.log("[sim] backfill done");
    process.exit(0);
  }

  if (SCALE) {
    await runScale(numArg("--gateways", 500), numArg("--meters", 16), numArg("--interval", 15000), numArg("--duration", 0));
    return;
  }

  const client = mqtt.connect(BROKER, { clientId: `enertrek-sim-${Date.now()}`, username: process.env.MQTT_USERNAME || undefined, password: process.env.MQTT_PASSWORD || undefined });

  client.on("connect", () => {
    console.log(`[sim] connected to ${BROKER}`);

    setInterval(() => {
      const now = new Date();
      const payload = [
        { addr: 1, model: "PEM3000", data: genReading(`${G30_UID}:1`, 60, 5 / 3600, now) },
        { addr: 2, model: "SEM3250", data: genReading(`${G30_UID}:2`, 25, 5 / 3600, now) },
      ];
      client.publish(`matis/gateway/pVariable/${G30_UID}`, JSON.stringify(payload));
    }, 5000);

    setInterval(() => {
      const reading = genReading(`${C30_UID}:1`, 40, 10 / 3600, new Date());
      const frame = buildC30Response(1, 0x0000, 0x56, reading);
      client.publish(`d2g/${C30_UID}`, frame);
    }, 10000);

    client.subscribe(`g2d/${C30_UID}`);
    // v8/D5: OTA management channel — any gateway uid (incl. temp probe
    // gateways): cmd on g2d/<uid>/ota, ack back on d2g/<uid>/ota.
    client.subscribe(`g2d/+/ota`);
  });

  // v8/D5: OTA cmd handler — cmd g2d/<uid>/ota → ack d2g/<uid>/ota.
  const otaState = new Map<string, { firmwareVersion: string; config: Record<string, unknown> }>();
  client.on("message", (topic, payload) => {
    const m = /^g2d\/([^/]+)\/ota$/.exec(topic);
    if (!m) return;
    const uid = m[1];
    let frame: { jobId?: number; type?: string; payload?: Record<string, unknown> };
    try {
      frame = JSON.parse(payload.toString("utf8"));
    } catch {
      console.log(`[sim] OTA: non-JSON frame on ${topic} — ignored`);
      return;
    }
    const st = otaState.get(uid) ?? { firmwareVersion: "1.0.0", config: {} };
    otaState.set(uid, st);
    let ack: Record<string, unknown>;
    if (frame.type === "firmware") {
      const version = typeof frame.payload?.version === "string" ? frame.payload.version : null;
      if (!version || !frame.payload?.url) {
        ack = { jobId: frame.jobId, status: "failed", error: "firmware payload requires {version, url}" };
      } else {
        st.firmwareVersion = version;
        ack = { jobId: frame.jobId, status: "ack", firmwareVersion: version };
      }
    } else if (frame.type === "config") {
      Object.assign(st.config, frame.payload ?? {});
      ack = { jobId: frame.jobId, status: "ack" };
    } else {
      ack = { jobId: frame.jobId, status: "failed", error: `unknown job type ${frame.type}` };
    }
    console.log(`[sim] OTA cmd uid=${uid} type=${frame.type} job=${frame.jobId} → ${ack.status}`);
    setTimeout(() => client.publish(`d2g/${uid}/ota`, JSON.stringify(ack), { qos: 1 }), 300);
  });

  client.on("message", (topic, payload) => {
    if (topic !== `g2d/${C30_UID}`) return;
    if (payload.length < 8) return;
    const slave = payload.readUInt8(0);
    const fc = payload.readUInt8(1);
    if (fc !== 3 && fc !== 4) return;
    const start = payload.readUInt16BE(2);
    const qty = payload.readUInt16BE(4);
    console.log(`[sim] C30 read request: slave=${slave} fc=${fc} start=0x${start.toString(16)} qty=${qty}`);
    const reading = genReading(`${C30_UID}:1`, 40, 0, new Date());
    const frame = buildC30Response(slave, start, qty, reading);
    setTimeout(() => client.publish(`d2g/${C30_UID}`, frame), 300);
  });

  client.on("error", (e) => console.error("[sim] mqtt error:", e.message));

  if (BACKFILL) {
    setTimeout(() => {
      backfill()
        .then(() => console.log("[sim] backfill done"))
        .catch((e) => console.error("[sim] backfill failed:", e));
    }, 4000);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

void buildReadRequest;
