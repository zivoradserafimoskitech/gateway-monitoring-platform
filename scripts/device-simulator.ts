// PV inverter & BESS simulator — speaks Modbus TCP exactly like real devices.
//
// One TCP server hosts many unit IDs (like a plant Modbus gateway). Each
// simulated device is bound to a device profile (register map), so the poller
// exercises the SAME decode path (addresses, scales, word order) as production.
//
// Physics:
// - Inverters follow a daylight bell curve with cloud noise; energy counters
//   accumulate; DC voltage collapses at night; fault injection supported.
// - BESS units charge at solar noon, discharge in the evening; SOC integrates
//   power; SOH/temps/cycle counters stay plausible.
//
// Used by scripts/test-pv-e2e.ts in-process, and standalone:
//   npx tsx scripts/device-simulator.ts --port 5021 --inverters 6 --bess 2
import ModbusRTU from "modbus-serial";
import type { RegisterDef } from "@contracts/modbus";
import { shiftedAddress } from "@contracts/modbus";

export interface SimProfile {
  model: string;
  deviceType: "inverter" | "bess";
  registerMap: RegisterDef[];
}

export interface SimDevice {
  unitId: number;
  profile: SimProfile;
  capacityKw: number; // inverter AC capacity / BESS power rating
  // mutable physics state
  faultCode: number;
  forcedSoc: number | null;
  soc: number; // %
  energyTotalKwh: number;
  energyTodayKwh: number;
  chargeTotalKwh: number;
  dischargeTotalKwh: number;
  cycles: number;
  // model-specific aux state (e.g. ESMU heartbeat, session timers)
  extra: Record<string, number>;
}

export interface SimHandle {
  port: number;
  devices: SimDevice[];
  setFault(unitId: number, code: number): void;
  setSoc(unitId: number, pct: number): void;
  stop(): Promise<void>;
}

// register image: Map<"fc:address", word>
type Image = Map<string, number>;

function wordsOf(t: RegisterDef["type"]): number {
  return t === "float32" || t === "u32" || t === "i32" ? 2 : 1;
}

// Encode one logical value into register words honoring type/scale/offset/wordSwap.
// Multi-object profiles (addressStride) place the value in this unit's block —
// the exact inverse of what the poller decodes.
function encode(def: RegisterDef, value: number, img: Image, unitId: number): void {
  const off = def.offset ?? 0;
  const raw = def.scale !== 0 ? (value - off) / def.scale : value - off;
  const address = shiftedAddress(def, unitId);
  const size = wordsOf(def.type) * 2;
  const buf = Buffer.alloc(size);
  switch (def.type) {
    case "float32":
      buf.writeFloatBE(raw, 0);
      break;
    case "u32":
      buf.writeUInt32BE(Math.round(raw) >>> 0, 0);
      break;
    case "i32":
      buf.writeInt32BE(Math.round(raw), 0);
      break;
    case "u16":
      buf.writeUInt16BE(Math.round(raw) & 0xffff, 0);
      break;
    case "i16":
      buf.writeInt16BE(Math.round(raw), 0);
      break;
  }
  if (def.wordSwap && size === 4) {
    // device sends CDAB — swap the two 16-bit words
    const w0 = buf.readUInt16BE(0);
    buf.writeUInt16BE(buf.readUInt16BE(2), 0);
    buf.writeUInt16BE(w0, 2);
  }
  for (let w = 0; w < size / 2; w++) {
    img.set(`${def.functionCode}:${address + w}`, buf.readUInt16BE(w * 2));
  }
}

// ─── Physics ─────────────────────────────────────────────────────────────────
function dayFactor(now: Date): number {
  // Bell curve between 06:00 and 20:00, peak at 13:00
  const h = now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
  if (h < 6 || h > 20) return 0;
  const x = (h - 13) / 3.5;
  return Math.exp(-x * x);
}

function inverterValues(dev: SimDevice, now: Date, tickSec: number): Record<string, number> {
  const sun = dayFactor(now);
  const noise = sun > 0 ? 0.92 + Math.random() * 0.08 : 0;
  const fault = dev.faultCode !== 0;
  const pKw = fault ? 0 : dev.capacityKw * sun * noise;
  dev.energyTodayKwh += (pKw * tickSec) / 3600;
  dev.energyTotalKwh += (pKw * tickSec) / 3600;
  const producing = pKw > 0.05;
  const perMpptV = producing ? 620 + Math.random() * 80 : 20 + Math.random() * 10;
  const v: Record<string, number> = {
    activePowerKw: pKw,
    dcPowerKw: pKw > 0 ? pKw * 1.02 : 0,
    voltageL1: 231 + Math.random() * 2,
    voltageL2: 230 + Math.random() * 2,
    voltageL3: 232 + Math.random() * 2,
    currentL1: producing ? (pKw * 1000) / (3 * 231) : 0,
    currentL2: producing ? (pKw * 1000) / (3 * 230) : 0,
    currentL3: producing ? (pKw * 1000) / (3 * 232) : 0,
    frequencyHz: 50 + (Math.random() - 0.5) * 0.04,
    powerFactor: 0.99 + Math.random() * 0.01,
    reactivePowerKvar: pKw * 0.05,
    energyTodayKwh: dev.energyTodayKwh,
    energyTotalKwh: dev.energyTotalKwh,
    heatsinkTempC: 25 + sun * 25 + Math.random() * 2,
    internalTempC: 24 + sun * 20 + Math.random() * 2,
    statusCode: fault ? 3 : producing ? 2 : 1, // 1=standby 2=running 3=fault
    faultCode: dev.faultCode,
  };
  for (let m = 1; m <= 4; m++) {
    v[`dcVoltageMppt${m}`] = perMpptV;
    v[`dcCurrentMppt${m}`] = producing ? (pKw * 1000) / 2 / perMpptV / 1.02 : 0;
  }
  return v;
}

function bessValues(dev: SimDevice, now: Date, tickSec: number): Record<string, number> {
  const h = now.getHours() + now.getMinutes() / 60;
  // Charge 09–15, discharge 18–23, idle otherwise
  let pKw = 0; // + discharge, - charge
  if (h >= 9 && h < 15 && (dev.forcedSoc ?? dev.soc) < 98) pKw = -dev.capacityKw * 0.9;
  else if (h >= 18 && h < 23 && (dev.forcedSoc ?? dev.soc) > 12) pKw = dev.capacityKw * 0.9;
  if (dev.faultCode !== 0) pKw = 0;

  let soc = dev.forcedSoc ?? dev.soc;
  const battKwh = dev.capacityKw * 2.5; // 2.5h battery
  soc = Math.min(100, Math.max(5, soc - (pKw * tickSec) / 3600 / battKwh * 100));
  dev.soc = soc;
  if (pKw < 0) dev.chargeTotalKwh += (-pKw * tickSec) / 3600;
  if (pKw > 0) dev.dischargeTotalKwh += (pKw * tickSec) / 3600;
  if (dev.forcedSoc !== null) dev.soc = dev.forcedSoc;

  const vNom = 51.2 * Math.ceil(dev.capacityKw / 5); // scale pack with rating
  return {
    socPercent: soc,
    sohPercent: 97.5,
    batteryVoltageV: vNom * (0.94 + (soc / 100) * 0.12),
    batteryCurrentA: pKw !== 0 ? (pKw * 1000) / vNom : 0,
    batteryPowerKw: pKw,
    chargePowerKw: pKw < 0 ? -pKw : 0,
    dischargePowerKw: pKw > 0 ? pKw : 0,
    chargeEnergyTotalKwh: dev.chargeTotalKwh,
    dischargeEnergyTotalKwh: dev.dischargeTotalKwh,
    chargeEnergyTodayKwh: dev.chargeTotalKwh,
    dischargeEnergyTodayKwh: dev.dischargeTotalKwh,
    cellTempMaxC: 28 + Math.abs(pKw) * 0.8 + Math.random(),
    cellTempMinC: 26 + Math.abs(pKw) * 0.6,
    cyclesCount: Math.floor(dev.cycles),
    bmsStatusCode: dev.faultCode !== 0 ? 2 : pKw !== 0 ? 1 : 0,
    faultCode: dev.faultCode,
    activePowerKw: pKw,
  };
}

// ─── ESMU (BAMS) physics ─────────────────────────────────────────────────────
// High-voltage LFP stack (~240S, 768 V nominal) with paralleled strings.
// Stack (unit 1) and strings (units 2+) share the schedule; strings are
// near-equal splits of the stack with small per-string spread.
function esmuValues(dev: SimDevice, now: Date, tickSec: number): Record<string, number> {
  const isStack = dev.profile.model === "esmu-bams-stack";
  const h = now.getHours() + now.getMinutes() / 60;
  // Same daily schedule as generic BESS: charge 09–15, discharge 18–23
  let pKw = 0; // + discharge, - charge
  if (h >= 9 && h < 15 && (dev.forcedSoc ?? dev.soc) < 98) pKw = -dev.capacityKw * 0.9;
  else if (h >= 18 && h < 23 && (dev.forcedSoc ?? dev.soc) > 12) pKw = dev.capacityKw * 0.9;
  if (dev.faultCode !== 0) pKw = 0;

  let soc = dev.forcedSoc ?? dev.soc;
  const battKwh = dev.capacityKw * 4; // 4h battery (grid-scale stack/string)
  soc = Math.min(100, Math.max(5, soc - ((pKw * tickSec) / 3600 / battKwh) * 100));
  dev.soc = soc;
  if (pKw < 0) dev.chargeTotalKwh += (-pKw * tickSec) / 3600;
  if (pKw > 0) dev.dischargeTotalKwh += (pKw * tickSec) / 3600;
  if (dev.forcedSoc !== null) dev.soc = dev.forcedSoc;
  dev.extra.chargeTimeSec = (dev.extra.chargeTimeSec ?? 0) + (pKw < 0 ? tickSec : 0);
  dev.extra.dischargeTimeSec = (dev.extra.dischargeTimeSec ?? 0) + (pKw > 0 ? tickSec : 0);
  dev.extra.heartbeat = ((dev.extra.heartbeat ?? 0) + 1) % 65536;

  const fault = dev.faultCode !== 0;
  const vNom = 768 * (0.94 + (soc / 100) * 0.12) + (dev.unitId - 1) * 0.3; // slight per-string spread
  const current = pKw !== 0 ? (pKw * 1000) / vNom : 0;
  const cellAvg = 3.2 + (soc / 100) * 0.25; // LFP curve 3.20–3.45 V
  const tempAvg = 25 + (Math.abs(pKw) / dev.capacityKw) * 8;
  // ESMU native state enum: 1 charging, 2 discharging, 3 ready, 8 fault
  const state = fault ? 8 : pKw < 0 ? 1 : pKw > 0 ? 2 : 3;

  const v: Record<string, number> = {
    socPercent: Math.round(soc), // ESMU SOC registers are 1 %/bit integers
    sohPercent: 97,
    batteryVoltageV: vNom,
    batteryCurrentA: current,
    bmsStatusCode: state,
    chargeDischargeState: pKw < 0 ? 2 : pKw > 0 ? 1 : 0,
    insulationResistanceKohm: 1500 + Math.round(Math.random() * 100),
    maxChargePowerKw: dev.capacityKw,
    maxDischargePowerKw: dev.capacityKw,
    maxChargeCurrentA: Math.round((dev.capacityKw * 1000) / 700),
    maxDischargeCurrentA: Math.round((dev.capacityKw * 1000) / 700),
    chargeEnergyTotalKwh: dev.chargeTotalKwh,
    dischargeEnergyTotalKwh: dev.dischargeTotalKwh,
    chargeEnergySingleKwh: dev.chargeTotalKwh,
    dischargeEnergySingleKwh: dev.dischargeTotalKwh,
    chargeEnergyTodayKwh: dev.chargeTotalKwh,
    dischargeEnergyTodayKwh: dev.dischargeTotalKwh,
    chargeableEnergyKwh: ((100 - soc) / 100) * battKwh,
    dischargeableEnergyKwh: ((soc - 5) / 100) * battKwh,
    cellVoltageAvgV: cellAvg,
    cellVoltageMaxV: cellAvg + 0.02,
    cellVoltageMinV: cellAvg - 0.02,
    cellVoltageMaxCellNo: 40 + dev.unitId,
    cellVoltageMinCellNo: 120 + dev.unitId,
    cellVoltageMaxStringNo: 1,
    cellVoltageMinStringNo: 2,
    cellTempAvgC: tempAvg,
    cellTempMaxC: tempAvg + 3,
    cellTempMinC: tempAvg - 2,
    cellTempMaxCellNo: 55 + dev.unitId,
    cellTempMinCellNo: 130 + dev.unitId,
    cellTempMaxStringNo: 1,
    cellTempMinStringNo: 2,
    cellSocMaxPercent: Math.min(100, Math.round(soc) + 2),
    cellSocMinPercent: Math.max(0, Math.round(soc) - 2),
    cellSocMaxCellNo: 12 + dev.unitId,
    cellSocMinCellNo: 88 + dev.unitId,
    cellSohMaxPercent: 98,
    cellSohMinPercent: 96,
    cellSohMaxCellNo: 30 + dev.unitId,
    cellSohMinCellNo: 140 + dev.unitId,
    moduleTempC: tempAvg - 1,
    batteryTempAvgC: tempAvg,
    chargeTimeTotalSec: Math.round(dev.extra.chargeTimeSec),
    dischargeTimeTotalSec: Math.round(dev.extra.dischargeTimeSec),
    chargeTimeAvailMin: Math.round((((100 - soc) / 100) * battKwh) / dev.capacityKw) * 60,
    dischargeTimeAvailMin: Math.round((((soc - 5) / 100) * battKwh) / dev.capacityKw) * 60,
    chargeCyclesToday: 1,
    dischargeCyclesToday: 1,
    breakerStatus: fault ? 0 : 1,
    pcsCommFault: 0,
    emsCommFault: 0,
    stringCount: 2,
    heartbeatCounter: dev.extra.heartbeat,
    maxChargeVoltageV: 840,
    maxDischargeVoltageV: 696,
    di1: 0, di2: 0, di3: 0, di4: 0, di5: 0, di6: 0, di7: 0, di8: 0,
    faultCode: dev.faultCode,
  };
  if (!isStack) {
    // string-level: limits scale to one string
    v.maxChargePowerKw = dev.capacityKw;
    v.maxDischargePowerKw = dev.capacityKw;
  }
  return v;
}

export async function startSimulator(opts: {
  port: number;
  profiles: SimProfile[]; // device i gets profiles[i % len]
  counts?: Partial<Record<"inverter" | "bess", number>>;
  // Explicit per-unit assignment (overrides counts) — for multi-object devices
  // like ESMU where unit 1 = stack and units 2+ = strings of specific models.
  devices?: Array<{ unitId: number; model: string; capacityKw?: number; soc?: number }>;
  tickMs?: number;
  host?: string;
}): Promise<SimHandle> {
  const port = opts.port;
  const tickMs = opts.tickMs ?? 5000;
  const tickSec = tickMs / 1000;
  const counts = { inverter: 6, bess: 2, ...opts.counts };

  const devices: SimDevice[] = [];
  if (opts.devices) {
    for (const d of opts.devices) {
      const profile = opts.profiles.find((p) => p.model === d.model);
      if (!profile) throw new Error(`explicit sim device: profile ${d.model} not in pool`);
      devices.push({
        unitId: d.unitId,
        profile,
        capacityKw: d.capacityKw ?? 100,
        faultCode: 0,
        forcedSoc: null,
        soc: d.soc ?? 55,
        energyTotalKwh: 12000,
        energyTodayKwh: 5,
        chargeTotalKwh: 3000,
        dischargeTotalKwh: 2800,
        cycles: 120,
        extra: {},
      });
    }
  } else {
    let unit = 1;
    for (const type of ["inverter", "bess"] as const) {
      const pool = opts.profiles.filter((p) => p.deviceType === type);
      for (let i = 0; i < counts[type]; i++) {
        const profile = pool[i % pool.length];
        devices.push({
          unitId: unit++,
          profile,
          capacityKw: type === "inverter" ? 30 + (i % 4) * 20 : 10 + (i % 2) * 10,
          faultCode: 0,
          forcedSoc: null,
          soc: 55 + (i % 3) * 10,
          energyTotalKwh: 12000 + i * 500,
          energyTodayKwh: 5 + i,
          chargeTotalKwh: 3000 + i * 100,
          dischargeTotalKwh: 2800 + i * 100,
          cycles: 120 + i * 7,
          extra: {},
        });
      }
    }
  }

  const images = new Map<number, Image>();
  const rebuild = () => {
    const now = new Date();
    for (const dev of devices) {
      const vals =
        dev.profile.model.startsWith("esmu-")
          ? esmuValues(dev, now, tickSec)
          : dev.profile.deviceType === "inverter"
            ? inverterValues(dev, now, tickSec)
            : bessValues(dev, now, tickSec);
      const img: Image = images.get(dev.unitId) ?? new Map();
      for (const def of dev.profile.registerMap) {
        const value = vals[def.key];
        if (value === undefined) continue; // register keeps last value
        encode(def, value, img, dev.unitId);
      }
      images.set(dev.unitId, img);
    }
  };
  rebuild();
  const ticker = setInterval(rebuild, tickMs);

  const vector = {
    getInputRegister: (addr: number, unitId: number) =>
      Promise.resolve(images.get(unitId)?.get(`4:${addr}`) ?? 0),
    getHoldingRegister: (addr: number, unitId: number) =>
      Promise.resolve(images.get(unitId)?.get(`3:${addr}`) ?? 0),
    getCoil: () => Promise.resolve(false),
    // v7/C12: accept FC6/FC16 writes into the register image so control
    // setpoints behave like a real device — a written holding register reads
    // back on subsequent polls (read-back verification path).
    setRegister: (addr: number, value: number, unitId: number) => {
      const img: Image = images.get(unitId) ?? new Map();
      img.set(`3:${addr}`, value & 0xffff);
      images.set(unitId, img);
      return Promise.resolve();
    },
    setCoil: () => Promise.resolve(),
  };

  const server = new ModbusRTU.ServerTCP(vector, {
    host: opts.host ?? "0.0.0.0",
    port,
    debug: false,
  });
  await new Promise<void>((resolve, reject) => {
    server.on("socketError", reject);
    setTimeout(resolve, 500); // give the listener a beat to bind
  });

  return {
    port,
    devices,
    setFault(unitId, code) {
      const d = devices.find((x) => x.unitId === unitId);
      if (d) d.faultCode = code;
    },
    setSoc(unitId, pct) {
      const d = devices.find((x) => x.unitId === unitId);
      if (d) d.forcedSoc = pct;
    },
    stop() {
      clearInterval(ticker);
      return new Promise((resolve) => {
        try {
          // @ts-expect-error server close typing
          server.close(() => resolve());
        } catch {
          resolve();
        }
      });
    },
  };
}

// ─── Standalone CLI ──────────────────────────────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith("device-simulator.ts")) {
  const arg = (name: string, dflt: number) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? Number(process.argv[i + 1]) : dflt;
  };
  const { DEVICE_PROFILE_LIBRARY } = await import("../db/device-profile-library");

  const plants = arg("plants", 0);
  if (process.argv.includes("--esmu")) {
    // ── ESMU (BAMS) mode: one TCP endpoint hosting a stack object (unit 1)
    // plus N string objects (units 2..N+1), exactly like a real ESMU.
    //   npx tsx scripts/device-simulator.ts --esmu --port 5022 --strings 2
    const strings = arg("strings", 2);
    const esmuProfiles: SimProfile[] = DEVICE_PROFILE_LIBRARY.filter((p) => p.model.startsWith("esmu-")).map(
      (p) => ({ model: p.model, deviceType: p.deviceType as "bess", registerMap: p.registerMap }),
    );
    if (esmuProfiles.length !== 2) throw new Error("esmu profiles missing from library");
    const explicit = [
      { unitId: 1, model: "esmu-bams-stack", capacityKw: 250, soc: 60 },
      ...Array.from({ length: strings }, (_, i) => ({
        unitId: i + 2,
        model: "esmu-bams-string",
        capacityKw: 125,
        soc: 58 + i * 4,
      })),
    ];
    const handle = await startSimulator({
      port: arg("port", 5022),
      profiles: esmuProfiles,
      devices: explicit,
    });
    console.log(
      `[sim] ESMU on :${handle.port} — unit 1=stack, units 2-${strings + 1}=strings ` +
        `(${handle.devices.length} objects)`,
    );
  } else if (plants > 0) {
    // ── Multi-plant scale mode ──────────────────────────────────────────────
    // N Modbus TCP servers (one per plant, ports base-port..base-port+N-1),
    // each with `ipp` inverters (units 1..ipp) and — for the first
    // `bess-plants` plants — one BESS (unit ipp+1). Brands rotate across the
    // researched (non-template) profiles. Layout is dumped to JSON so the
    // provisioning script can mirror the exact port/unit/model assignment.
    //   npx tsx scripts/device-simulator.ts --plants 30 --base-port 5101 --ipp 3 --bess-plants 20
    const { writeFileSync } = await import("node:fs");
    const basePort = arg("base-port", 5101);
    const ipp = arg("ipp", 3);
    const bessPlants = arg("bess-plants", 20);
    const layoutPath = process.argv.includes("--layout")
      ? process.argv[process.argv.indexOf("--layout") + 1]
      : "/tmp/pv-scale-layout.json";
    const invPool = DEVICE_PROFILE_LIBRARY.filter((p) => p.deviceType === "inverter" && p.source !== "template");
    const bessPool = DEVICE_PROFILE_LIBRARY.filter((p) => p.deviceType === "bess" && p.source !== "template");
    if (invPool.length === 0 || bessPool.length === 0) throw new Error("profile pools empty");

    const layout: Array<{ port: number; units: Array<{ unitId: number; model: string; deviceType: string }> }> = [];
    for (let i = 0; i < plants; i++) {
      const port = basePort + i;
      const hasBess = i < bessPlants;
      const simProfiles: SimProfile[] = [];
      for (let j = 0; j < ipp; j++) {
        const p = invPool[(i * ipp + j) % invPool.length];
        simProfiles.push({ model: p.model, deviceType: "inverter", registerMap: p.registerMap });
      }
      if (hasBess) {
        const p = bessPool[i % bessPool.length];
        simProfiles.push({ model: p.model, deviceType: "bess", registerMap: p.registerMap });
      }
      const handle = await startSimulator({
        port,
        profiles: simProfiles,
        counts: { inverter: ipp, bess: hasBess ? 1 : 0 },
      });
      layout.push({
        port,
        units: handle.devices.map((d) => ({ unitId: d.unitId, model: d.profile.model, deviceType: d.profile.deviceType })),
      });
    }
    writeFileSync(layoutPath, JSON.stringify(layout, null, 2));
    console.log(
      `[sim] ${plants} plants on :${basePort}-${basePort + plants - 1} ` +
        `(${ipp} inv each, BESS on first ${Math.min(bessPlants, plants)}), layout → ${layoutPath}`,
    );
  } else {
    const profiles: SimProfile[] = DEVICE_PROFILE_LIBRARY.filter(
      (p) => p.deviceType === "inverter" || p.deviceType === "bess",
    ).map((p) => ({ model: p.model, deviceType: p.deviceType, registerMap: p.registerMap }));
    const handle = await startSimulator({
      port: arg("port", 5021),
      profiles,
      counts: { inverter: arg("inverters", 6), bess: arg("bess", 2) },
    });
    console.log(
      `[sim] Modbus TCP server on :${handle.port}, units: ` +
        handle.devices.map((d) => `${d.unitId}=${d.profile.model}`).join(", "),
    );
  }
}
