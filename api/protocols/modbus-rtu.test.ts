import { describe, expect, it } from "vitest";
import { interFrameDelayMs, parseSerialSpec, pollRtu, withPort, type RtuClient } from "./modbus-rtu";

describe("Modbus RTU serial spec", () => {
  it("parses with defaults", () => {
    expect(parseSerialSpec("serial:/dev/ttyUSB0")).toEqual({ path: "/dev/ttyUSB0", baudRate: 9600, parity: "none", dataBits: 8, stopBits: 1 });
    expect(parseSerialSpec("serial:/dev/ttyS1?baud=19200&parity=even&stopBits=2")).toMatchObject({ baudRate: 19200, parity: "even", stopBits: 2 });
  });
  it("rejects bad specs", () => {
    for (const s of ["10.0.0.1", "serial:/etc/passwd;rm", "serial:/dev/ttyUSB0?baud=1234", "serial:/dev/ttyUSB0?parity=mark", "serial:/dev/ttyUSB0?dataBits=6"]) {
      expect(() => parseSerialSpec(s)).toThrow();
    }
  });
  it("computes the 3.5-char silence", () => {
    expect(interFrameDelayMs(9600)).toBeCloseTo(4.01, 1);
    expect(interFrameDelayMs(115200)).toBe(1.75);
  });
  it("serialises transactions per port", async () => {
    const log: string[] = [];
    const slow = (tag: string, ms: number) => () => new Promise<void>((r) => setTimeout(() => (log.push(tag), r()), ms));
    await Promise.all([withPort("/dev/a", slow("a1", 20)), withPort("/dev/a", slow("a2", 1)), withPort("/dev/b", slow("b1", 5))]);
    expect(log.indexOf("a1")).toBeLessThan(log.indexOf("a2"));
  });
  it("polls blocks and decodes", async () => {
    const calls: string[] = [];
    const fake: RtuClient = {
      connectRTUBuffered: async (p) => void calls.push(`open ${p}`),
      setID: (id) => void calls.push(`id ${id}`),
      setTimeout: () => undefined,
      readHoldingRegisters: async (a, n) => {
        calls.push(`fc3 ${a} ${n}`);
        const b = Buffer.alloc(n * 2);
        b.writeUInt16BE(2305, 0);
        return { buffer: b };
      },
      readInputRegisters: async () => ({ buffer: Buffer.alloc(2) }),
      close: (cb) => (calls.push("close"), cb()),
    };
    const r = await pollRtu(parseSerialSpec("serial:/dev/ttyUSB0"), 3, [
      { key: "voltageL1", label: "U", address: 0, functionCode: 3, type: "u16", scale: 0.1, unit: "V" },
    ], fake);
    expect(r.values.voltageL1).toBeCloseTo(230.5);
    expect(calls).toEqual(["open /dev/ttyUSB0", "id 3", "fc3 0 1", "close"]);
  });
});
