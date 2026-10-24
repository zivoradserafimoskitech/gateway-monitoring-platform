import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../queries/connection", () => ({ getDb: () => ({}) }));
import {
  COT,
  cp56ToMs,
  floatSetpointAsdu,
  iFrame,
  interrogationAsdu,
  parseAsdu,
  sFrame,
  splitApdus,
  TYPE,
  U,
  uFrame,
} from "./iec104-codec";
import { Iec104Client } from "./iec104-client";
import { decodeIec104Objects, adapterForHost } from "./adapter";

function measAsdu(cot: number, ca: number, items: Array<[number, number]>): Buffer {
  const parts = [Buffer.from([TYPE.M_ME_NC_1, items.length, cot, 0, ca & 0xff, ca >> 8])];
  for (const [ioa, v] of items) {
    const b = Buffer.alloc(8);
    b.writeUIntLE(ioa, 0, 3);
    b.writeFloatLE(v, 3);
    b[7] = 0;
    parts.push(b);
  }
  return Buffer.concat(parts);
}

describe("IEC 104 codec", () => {
  it("builds U/S/I frames and splits a stream with a partial tail", () => {
    expect([...uFrame(U.STARTDT_ACT)]).toEqual([0x68, 4, 0x07, 0, 0, 0]);
    expect([...sFrame(300)]).toEqual([0x68, 4, 1, 0, (300 << 1) & 0xfe, 300 >> 7]);
    const i = iFrame(5, 7, interrogationAsdu(1));
    const stream = Buffer.concat([uFrame(U.TESTFR_ACT), i, i.subarray(0, 3)]);
    const { frames, rest } = splitApdus(stream);
    expect(frames[0]).toEqual({ kind: "U", fn: U.TESTFR_ACT });
    expect(frames[1]).toMatchObject({ kind: "I", ns: 5, nr: 7 });
    expect(rest.length).toBe(3);
  });
  it("rejects garbage", () => {
    expect(() => splitApdus(Buffer.from([0x00, 4, 0, 0, 0, 0]))).toThrow();
  });
  it("parses short floats, SQ sequences, quality and CP56 time", () => {
    const a = parseAsdu(measAsdu(COT.INTERROGATED, 1, [[1001, 42.5], [1002, -3]]));
    expect(a.typeId).toBe(TYPE.M_ME_NC_1);
    expect(a.objects.map((o) => [o.ioa, o.value, o.good])).toEqual([[1001, 42.5, true], [1002, -3, true]]);
    // SQ scaled values, 2 objects starting at IOA 10, second one invalid (IV)
    const sq = Buffer.from([TYPE.M_ME_NB_1, 0x82, 3, 0, 1, 0, 10, 0, 0, 0x64, 0x00, 0x00, 0x9c, 0xff, 0x80]);
    const p = parseAsdu(sq);
    expect(p.objects).toEqual([{ ioa: 10, value: 100, good: true }, { ioa: 11, value: -100, good: false }]);
    const t = Buffer.from([0x10, 0x27, 30, 12, 24, 10, 26]); // 10.000 s, 12:30, 24.10.2026
    expect(new Date(cp56ToMs(t, 0)).toISOString()).toBe("2026-10-24T12:30:10.000Z");
  });
  it("encodes a float setpoint", () => {
    const a = floatSetpointAsdu(1, 2001, 55.5);
    const p = parseAsdu(a);
    expect(p).toMatchObject({ typeId: TYPE.C_SE_NC_1, cot: COT.ACTIVATION, ca: 1 });
    expect(p.objects[0]).toMatchObject({ ioa: 2001, value: 55.5 });
  });
  it("maps IOAs to metric keys with scale, quality and bounds", () => {
    const map = [
      { key: "activePowerKw", label: "P", address: 1001, functionCode: 3 as const, type: "float32" as const, scale: 0.001, unit: "kW" },
      { key: "socPercent", label: "SoC", address: 1002, functionCode: 3 as const, type: "float32" as const, scale: 1, unit: "%", min: 0, max: 100 },
    ];
    expect(decodeIec104Objects(map, [{ ioa: 1001, value: 5000, good: true }, { ioa: 1002, value: 150, good: true }, { ioa: 9, value: 1, good: true }])).toEqual({ activePowerKw: 5 });
  });
  it("picks adapters by host/profile", () => {
    expect(adapterForHost("serial:/dev/ttyUSB0").protocol).toBe("modbus-rtu");
    expect(adapterForHost("10.0.0.5", "iec104").protocol).toBe("iec104");
    expect(adapterForHost("10.0.0.5").protocol).toBe("modbus");
  });
});

describe("IEC 104 client against a fake outstation", () => {
  let server: net.Server | null = null;
  afterEach(() => server?.close());

  async function outstation(onAsdu: (a: ReturnType<typeof parseAsdu>, send: (asdu: Buffer) => void) => void): Promise<number> {
    server = net.createServer((sock) => {
      let ns = 0;
      let buf: Buffer = Buffer.alloc(0);
      const send = (asdu: Buffer) => sock.write(iFrame(ns++, 0, asdu));
      sock.on("data", (d) => {
        buf = Buffer.concat([buf, d]);
        const r = splitApdus(buf);
        buf = r.rest;
        for (const f of r.frames) {
          if (f.kind === "U" && f.fn === U.STARTDT_ACT) sock.write(uFrame(U.STARTDT_CON));
          if (f.kind === "I") onAsdu(parseAsdu(f.asdu), send);
        }
      });
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", () => r()));
    return (server!.address() as net.AddressInfo).port;
  }

  it("runs a general interrogation", async () => {
    const port = await outstation((a, send) => {
      if (a.typeId !== TYPE.C_IC_NA_1) return;
      const con = interrogationAsdu(1);
      con[2] = COT.ACTIVATION_CON;
      send(con);
      send(measAsdu(COT.INTERROGATED, 1, [[1001, 12.5], [1002, 80]]));
      const term = interrogationAsdu(1);
      term[2] = COT.ACTIVATION_TERM;
      send(term);
    });
    const c = new Iec104Client({ host: "127.0.0.1", port, commonAddress: 1, t1Ms: 2000 });
    await c.connect();
    const objs = await c.interrogate();
    c.close();
    expect(objs.map((o) => [o.ioa, o.value])).toEqual([[1001, 12.5], [1002, 80]]);
  });

  it("confirms or refuses a setpoint", async () => {
    let refuse = false;
    const port = await outstation((a, send) => {
      if (a.typeId !== TYPE.C_SE_NC_1) return;
      const con = floatSetpointAsdu(1, a.objects[0].ioa, a.objects[0].value);
      con[2] = COT.ACTIVATION_CON | (refuse ? 0x40 : 0);
      send(con);
    });
    const c = new Iec104Client({ host: "127.0.0.1", port, commonAddress: 1, t1Ms: 2000 });
    await c.connect();
    expect(await c.setFloat(2001, 50)).toEqual({ confirmed: true, detail: "activation confirmed" });
    refuse = true;
    expect((await c.setFloat(2001, 60)).confirmed).toBe(false);
    c.close();
  });
});
