// Minimal IEC 60870-5-104 master (client) over TCP.
//
// Implements what monitoring + setpoints need: STARTDT, general interrogation,
// spontaneous data collection, float setpoints with activation confirmation,
// S-frame acknowledgement every `w` I-frames, TESTFR keep-alive answers and
// t1 response timeouts. One connection per call (poll/command) — the same
// throwaway-connection model the Modbus TCP control path uses.
import net from "node:net";
import {
  COT,
  floatSetpointAsdu,
  iFrame,
  interrogationAsdu,
  parseAsdu,
  sFrame,
  splitApdus,
  TYPE,
  U,
  uFrame,
  type Asdu,
  type InfoObject,
  Iec104Error,
} from "./iec104-codec";

export interface Iec104Options {
  host: string;
  port?: number; // 2404
  commonAddress: number;
  originator?: number;
  t1Ms?: number; // response timeout, default 15 s
  w?: number; // ack after w received I-frames, default 8
}

export class Iec104Client {
  private sock: net.Socket | null = null;
  private buf: Buffer = Buffer.alloc(0);
  private ns = 0;
  private nr = 0;
  private unacked = 0;
  private listeners: Array<(a: Asdu) => void> = [];
  private uWaiters: Array<{ fn: number; resolve: () => void }> = [];

  constructor(private readonly o: Iec104Options) {}

  private get t1(): number {
    return this.o.t1Ms ?? 15_000;
  }

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const s = net.createConnection({ host: this.o.host, port: this.o.port ?? 2404 });
      const timer = setTimeout(() => {
        s.destroy();
        reject(new Iec104Error(`connect timeout to ${this.o.host}`));
      }, this.t1);
      s.once("connect", () => {
        clearTimeout(timer);
        resolve();
      });
      s.once("error", (e) => {
        clearTimeout(timer);
        reject(e);
      });
      s.on("data", (d) => this.onData(d));
      this.sock = s;
    });
    this.write(uFrame(U.STARTDT_ACT));
    await this.waitU(U.STARTDT_CON);
  }

  close(): void {
    this.sock?.destroy();
    this.sock = null;
  }

  private write(b: Buffer): void {
    if (!this.sock) throw new Iec104Error("not connected");
    this.sock.write(b);
  }

  private waitU(fn: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Iec104Error(`no U-frame 0x${fn.toString(16)} within t1`)), this.t1);
      this.uWaiters.push({ fn, resolve: () => (clearTimeout(t), resolve()) });
    });
  }

  private onData(d: Buffer): void {
    this.buf = Buffer.concat([this.buf, d]);
    const { frames, rest } = splitApdus(this.buf);
    this.buf = rest;
    for (const f of frames) {
      if (f.kind === "U") {
        if (f.fn === U.TESTFR_ACT) this.write(uFrame(U.TESTFR_CON));
        const i = this.uWaiters.findIndex((w) => w.fn === f.fn);
        if (i >= 0) this.uWaiters.splice(i, 1)[0].resolve();
      } else if (f.kind === "I") {
        this.nr = (f.ns + 1) & 0x7fff;
        if (++this.unacked >= (this.o.w ?? 8)) {
          this.write(sFrame(this.nr));
          this.unacked = 0;
        }
        const asdu = parseAsdu(f.asdu);
        for (const l of [...this.listeners]) l(asdu);
      }
    }
  }

  private sendAsdu(asdu: Buffer): void {
    this.write(iFrame(this.ns, this.nr, asdu));
    this.ns = (this.ns + 1) & 0x7fff;
    this.unacked = 0;
  }

  /** General interrogation: collect every object until ACT_TERM. */
  async interrogate(): Promise<InfoObject[]> {
    const out = new Map<number, InfoObject>();
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => done(new Iec104Error("interrogation did not terminate within t1")), this.t1);
      const l = (a: Asdu) => {
        if (a.typeId === TYPE.C_IC_NA_1) {
          if (a.cot === COT.ACTIVATION_CON && a.negative) done(new Iec104Error("interrogation refused by outstation"));
          if (a.cot === COT.ACTIVATION_TERM) done();
          return;
        }
        for (const ob of a.objects) out.set(ob.ioa, ob);
      };
      const done = (e?: Error) => {
        clearTimeout(t);
        this.listeners = this.listeners.filter((x) => x !== l);
        if (e) reject(e);
        else resolve();
      };
      this.listeners.push(l);
      this.sendAsdu(interrogationAsdu(this.o.commonAddress, this.o.originator ?? 0));
    });
    return [...out.values()];
  }

  /** Float setpoint, direct execute; resolves on positive ACT_CON. */
  async setFloat(ioa: number, value: number): Promise<{ confirmed: boolean; detail: string }> {
    return new Promise((resolve) => {
      const t = setTimeout(() => done({ confirmed: false, detail: "no activation confirmation within t1" }), this.t1);
      const l = (a: Asdu) => {
        if (a.typeId !== TYPE.C_SE_NC_1 || a.objects[0]?.ioa !== ioa) return;
        if (a.cot === COT.ACTIVATION_CON) done(a.negative ? { confirmed: false, detail: "negative activation confirmation" } : { confirmed: true, detail: "activation confirmed" });
      };
      const done = (r: { confirmed: boolean; detail: string }) => {
        clearTimeout(t);
        this.listeners = this.listeners.filter((x) => x !== l);
        resolve(r);
      };
      this.listeners.push(l);
      this.sendAsdu(floatSetpointAsdu(this.o.commonAddress, ioa, value, this.o.originator ?? 0));
    });
  }
}
