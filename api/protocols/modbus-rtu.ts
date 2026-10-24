// Modbus RTU over a local serial line (RS-485), for a gateway/edge install of
// the platform that sits directly on the bus — complementing the existing
// Modbus TCP poller and the C30 transparent-MQTT RTU path.
//
// A device opts in by putting a serial spec in meters.host:
//   serial:/dev/ttyUSB0?baud=9600&parity=none&dataBits=8&stopBits=1
// One transaction at a time per port (RS-485 is half-duplex and shared).
import type { RegisterDef } from "@contracts/modbus";
import { buildBlocks, decodeRegisters } from "../modbus";

export interface SerialSpec {
  path: string;
  baudRate: number;
  parity: "none" | "even" | "odd";
  dataBits: 7 | 8;
  stopBits: 1 | 2;
}

export const SERIAL_PREFIX = "serial:";
const BAUDS = [1200, 2400, 4800, 9600, 19200, 38400, 57600, 115200];

export function isSerialHost(host: string | null | undefined): boolean {
  return typeof host === "string" && host.startsWith(SERIAL_PREFIX);
}

/** Parse "serial:/dev/ttyUSB0?baud=9600&parity=even". Throws on bad input. */
export function parseSerialSpec(host: string): SerialSpec {
  if (!isSerialHost(host)) throw new Error(`not a serial spec: ${host}`);
  const [path, query = ""] = host.slice(SERIAL_PREFIX.length).split("?");
  if (!/^(\/dev\/[A-Za-z0-9_./-]+|COM\d+)$/.test(path)) throw new Error(`invalid serial device path '${path}'`);
  const q = new URLSearchParams(query);
  const baudRate = Number(q.get("baud") ?? 9600);
  if (!BAUDS.includes(baudRate)) throw new Error(`unsupported baud rate ${baudRate}`);
  const parity = (q.get("parity") ?? "none") as SerialSpec["parity"];
  if (!["none", "even", "odd"].includes(parity)) throw new Error(`invalid parity '${parity}'`);
  const dataBits = Number(q.get("dataBits") ?? 8);
  if (dataBits !== 7 && dataBits !== 8) throw new Error(`invalid dataBits ${dataBits}`);
  const stopBits = Number(q.get("stopBits") ?? 1);
  if (stopBits !== 1 && stopBits !== 2) throw new Error(`invalid stopBits ${stopBits}`);
  return { path, baudRate, parity, dataBits, stopBits };
}

/**
 * Inter-frame silence the master must leave (3.5 character times; fixed
 * 1.75 ms above 19200 baud per the Modbus serial line spec).
 */
export function interFrameDelayMs(baud: number, bitsPerChar = 11): number {
  return baud > 19200 ? 1.75 : (3.5 * bitsPerChar * 1000) / baud;
}

// Per-port serialisation: chain every transaction onto the previous one.
const portQueues = new Map<string, Promise<unknown>>();

export function withPort<T>(path: string, fn: () => Promise<T>): Promise<T> {
  const prev = portQueues.get(path) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(fn);
  portQueues.set(path, next.catch(() => undefined));
  return next;
}

/** Minimal surface of modbus-serial used here (lets tests inject a fake). */
export interface RtuClient {
  connectRTUBuffered(path: string, opts: { baudRate: number; parity: string; dataBits: number; stopBits: number }): Promise<void>;
  setID(id: number): void;
  setTimeout(ms: number): void;
  readHoldingRegisters(addr: number, len: number): Promise<{ buffer: Buffer }>;
  readInputRegisters(addr: number, len: number): Promise<{ buffer: Buffer }>;
  close(cb: () => void): void;
}

export async function newRtuClient(): Promise<RtuClient> {
  const { default: ModbusRTU } = await import("modbus-serial");
  return new ModbusRTU() as unknown as RtuClient;
}

/** Read every block of a register map from one slave and decode it. */
export async function pollRtu(
  spec: SerialSpec,
  unitId: number,
  map: RegisterDef[],
  client?: RtuClient,
): Promise<{ values: Record<string, number>; rejected: number }> {
  return withPort(spec.path, async () => {
    const c = client ?? (await newRtuClient());
    await c.connectRTUBuffered(spec.path, spec);
    try {
      c.setID(unitId);
      c.setTimeout(2000);
      const values: Record<string, number> = {};
      let rejected = 0;
      for (const b of buildBlocks(map)) {
        const r = b.functionCode === 3 ? await c.readHoldingRegisters(b.start, b.words) : await c.readInputRegisters(b.start, b.words);
        const d = decodeRegisters(b.defs, r.buffer, b.start);
        Object.assign(values, d.values);
        rejected += d.rejected.length;
      }
      return { values, rejected };
    } finally {
      c.close(() => undefined);
    }
  });
}
