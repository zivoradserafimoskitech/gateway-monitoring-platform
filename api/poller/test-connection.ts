// v7/C4: one-shot connection test used at registration time — opens its own
// short-lived socket (never the poller's pooled connections), reads the first
// block of the profile's register map and decodes it.
import ModbusRTU from "modbus-serial";
import { getRegisterMaps } from "../mqtt/handlers";
import { decodeRegisters } from "../modbus";
import { buildBlocks } from "./service";
import { shiftedAddress } from "@contracts/modbus";

export interface TestConnectionResult {
  ok: boolean;
  ms: number;
  values?: Record<string, number>;
  error?: string;
}

export async function testTcpConnection(
  model: string,
  host: string,
  port: number,
  unitId: number,
): Promise<TestConnectionResult> {
  const started = Date.now();
  const maps = await getRegisterMaps();
  const map = maps.get(model);
  if (!map || map.length === 0) return { ok: false, ms: 0, error: `no register map for model '${model}'` };

  const shifted = map.some((d) => d.addressStride)
    ? map.map((d) => ({ ...d, address: shiftedAddress(d, unitId) }))
    : map;
  const blocks = buildBlocks(shifted);
  const block = blocks[0];
  if (!block) return { ok: false, ms: 0, error: "profile has no readable register block" };

  const client = new ModbusRTU();
  client.setTimeout(8000);
  try {
    await client.connectTCP(host, { port });
    client.setID(unitId);
    const res =
      block.functionCode === 3
        ? await client.readHoldingRegisters(block.start, block.words)
        : await client.readInputRegisters(block.start, block.words);
    const values = decodeRegisters(block.defs, res.buffer, block.start);
    if (Object.keys(values).length === 0) {
      return { ok: false, ms: Date.now() - started, error: "device answered but no values decoded" };
    }
    return { ok: true, ms: Date.now() - started, values };
  } catch (e) {
    return { ok: false, ms: Date.now() - started, error: e instanceof Error ? e.message : String(e) };
  } finally {
    try {
      client.close(() => undefined);
    } catch {
      /* ignore */
    }
  }
}
