// D8: protocol adapter extension point.
//
// The platform today ingests and controls devices over two Modbus paths:
//   - Modbus TCP poller (api/poller/service.ts) — direct-Ethernet devices
//   - Modbus RTU over the C30 transparent MQTT channel (api/mqtt/*, api/modbus.ts)
// Both predate this interface and are intentionally NOT refactored here. This
// module defines the seam a NEW protocol (IEC 61850, DNP3, OCPP, M-Bus, ...)
// plugs into, and registers a Modbus adapter that delegates to the existing
// code paths to show the shape. See docs/protocols.md for the integration
// guide and per-protocol notes.
//
// What an adapter owns:
//   poll    — turn a device + its register map (or protocol equivalent) into
//             canonical metric values. Results MUST go through
//             persistTelemetry (api/mqtt/handlers.ts) so the WAL batch writer,
//             liveness tracking and alarm rules all apply unchanged.
//   decode  — raw response bytes → { metricKey: value } using the shared
//             RegisterDef conventions (contracts/modbus.ts).
//   control — validated setpoint writes. Reuse the safety model of
//             api/control/execute.ts: whitelist from device_profiles.controllable,
//             range clamp, RBAC at the tRPC layer, audit row per attempt.
import type { RegisterDef } from "@contracts/modbus";
import type { Meter } from "@db/schema";
import { decodeRegisters, registerSpan } from "../modbus";
import type { ControlResult } from "../control/execute";
import { parseAsdu } from "./iec104-codec";
import { Iec104Client } from "./iec104-client";
import { isSerialHost, parseSerialSpec, pollRtu } from "./modbus-rtu";

/** Canonical decoded sample, ready for persistTelemetry. */
export interface PollResult {
  values: Record<string, number>;
  /** Optional raw payload for debugging (frame hex, JSON text, ...). */
  raw?: unknown;
}

export interface AdapterCapabilities {
  poll: boolean;
  control: boolean;
  /** True when the adapter can discover devices/models on the bus itself. */
  discovery?: boolean;
}

export interface ProtocolAdapter {
  /** Registry key, e.g. "modbus" | "iec61850" | "dnp3" | "ocpp" | "mbus". */
  readonly protocol: string;
  readonly capabilities: AdapterCapabilities;

  /**
   * Decode raw response bytes against a register map. baseAddress is the PDU
   * start of the block the bytes were read from (see registerSpan).
   */
  decode(map: RegisterDef[], data: Buffer, baseAddress: number): Record<string, number>;

  /**
   * Plan one poll of a device. Optional at this layer: the existing Modbus
   * poller keeps its own loop/blocking (api/poller/service.ts buildBlocks);
   * adapters for non-Modbus protocols implement their full poll here and feed
   * persistTelemetry themselves.
   */
  poll?(meter: Meter): Promise<PollResult>;

  /**
   * Execute a validated setpoint write. Implementations MUST apply the same
   * whitelist/range/audit discipline as api/control/execute.ts — the simplest
   * conforming approach is to delegate to executeControl, as the Modbus
   * adapter below does.
   */
  control?(meter: Meter, key: string, value: number): Promise<ControlResult>;
}

// ─── Registry ────────────────────────────────────────────────────────────────

const registry = new Map<string, ProtocolAdapter>();

export function registerAdapter(adapter: ProtocolAdapter): void {
  if (registry.has(adapter.protocol)) {
    throw new Error(`protocol adapter '${adapter.protocol}' already registered`);
  }
  registry.set(adapter.protocol, adapter);
}

export function getAdapter(protocol: string): ProtocolAdapter | undefined {
  return registry.get(protocol);
}

export function listAdapters(): ProtocolAdapter[] {
  return [...registry.values()];
}

// ─── Modbus adapter (delegates to the existing implementation) ───────────────
//
// Conceptual conformance only: the live poll loops stay in api/poller/ and
// api/mqtt/. decode() wraps the shared codec; control() lazy-imports the
// executor so importing this module never opens a DB connection.

export const modbusAdapter: ProtocolAdapter = {
  protocol: "modbus",
  capabilities: { poll: true, control: true, discovery: false },

  decode(map: RegisterDef[], data: Buffer, baseAddress: number): Record<string, number> {
    // Out-of-bounds rejections (RegisterDef min/max) are dropped here as well;
    // the live paths (poller, C30 handler) count them — this registry seam is
    // currently not wired to any runtime path (see docs/protocols.md).
    return decodeRegisters(map, data, baseAddress).values;
  },

  async control(meter: Meter, key: string, value: number): Promise<ControlResult> {
    const { executeControl } = await import("../control/execute");
    return executeControl(meter, key, value);
  },
};

registerAdapter(modbusAdapter);

// ─── IEC 60870-5-104 adapter ─────────────────────────────────────────────────
//
// Register map convention: RegisterDef.address = IOA; scale/offset applied to
// the value the outstation sends (float/scaled/normalised). Common address =
// meter.unitId ?? meter.modbusAddress, port = meter.port ?? 2404.
// Controllable keys: ControllableDef.address = setpoint IOA (C_SE_NC_1); the
// value is sent as engineering units × scale. All safety gates of
// executeControl run first (dry run) — whitelist, verification, emergency
// stop, range — before the IEC command is sent.

export function decodeIec104Objects(map: RegisterDef[], objects: Array<{ ioa: number; value: number; good: boolean }>): Record<string, number> {
  const byIoa = new Map(map.map((d) => [d.address, d]));
  const out: Record<string, number> = {};
  for (const ob of objects) {
    const def = byIoa.get(ob.ioa);
    if (!def || !ob.good || !Number.isFinite(ob.value)) continue;
    const v = ob.value * def.scale + (def.offset ?? 0);
    if ((def.min !== undefined && v < def.min) || (def.max !== undefined && v > def.max)) continue;
    out[def.key] = v;
  }
  return out;
}

async function profileMap(model: string): Promise<RegisterDef[]> {
  const { getRegisterMaps } = await import("../mqtt/handlers");
  return (await getRegisterMaps()).get(model) ?? [];
}

export const iec104Adapter: ProtocolAdapter = {
  protocol: "iec104",
  capabilities: { poll: true, control: true, discovery: false },

  decode(map: RegisterDef[], data: Buffer): Record<string, number> {
    return decodeIec104Objects(map, parseAsdu(data).objects);
  },

  async poll(meter: Meter): Promise<PollResult> {
    if (!meter.host) throw new Error("IEC 104 device needs a host");
    const client = new Iec104Client({ host: meter.host, port: meter.port ?? 2404, commonAddress: meter.unitId ?? meter.modbusAddress });
    await client.connect();
    try {
      const objects = await client.interrogate();
      return { values: decodeIec104Objects(await profileMap(meter.model), objects), raw: objects };
    } finally {
      client.close();
    }
  },

  async control(meter: Meter, key: string, value: number): Promise<ControlResult> {
    const { executeControl, controllableForModel } = await import("../control/execute");
    await executeControl(meter, key, value, { dryRun: true }); // throws ControlError on any gate
    const def = (await controllableForModel(meter.model))[key];
    if (!meter.host) return { status: "failed", detail: "IEC 104 device needs a host" };
    const client = new Iec104Client({ host: meter.host, port: meter.port ?? 2404, commonAddress: meter.unitId ?? meter.modbusAddress });
    try {
      await client.connect();
      const r = await client.setFloat(def.address, value * (def.scale ?? 1));
      return { status: r.confirmed ? "ok" : "failed", detail: `IEC 104 C_SE_NC_1 IOA ${def.address} = ${value}: ${r.detail}` };
    } catch (e) {
      return { status: "failed", detail: e instanceof Error ? e.message : String(e) };
    } finally {
      client.close();
    }
  },
};

registerAdapter(iec104Adapter);

// ─── Modbus RTU (local serial line) adapter ──────────────────────────────────
//
// For devices whose meters.host is a serial spec ("serial:/dev/ttyUSB0?baud=9600").
// Poll reads the profile's blocks over RS-485; control is NOT offered on this
// path yet (writes stay on the audited TCP / C30 paths) — see docs/protocols.md.

export const modbusRtuAdapter: ProtocolAdapter = {
  protocol: "modbus-rtu",
  capabilities: { poll: true, control: false, discovery: false },

  decode(map: RegisterDef[], data: Buffer, baseAddress: number): Record<string, number> {
    return decodeRegisters(map, data, baseAddress).values;
  },

  async poll(meter: Meter): Promise<PollResult> {
    if (!isSerialHost(meter.host)) throw new Error("Modbus RTU device needs meters.host = serial:/dev/...");
    const spec = parseSerialSpec(meter.host!);
    const r = await pollRtu(spec, meter.unitId ?? meter.modbusAddress, await profileMap(meter.model));
    return { values: r.values, raw: { rejected: r.rejected } };
  },
};

registerAdapter(modbusRtuAdapter);

/** Which adapter serves a device: serial host → modbus-rtu, else by profile protocol. */
export function adapterForHost(host: string | null | undefined, profileProtocol?: string | null): ProtocolAdapter {
  if (isSerialHost(host)) return modbusRtuAdapter;
  if (profileProtocol === "iec104") return iec104Adapter;
  return modbusAdapter;
}

// Re-exported so adapter authors can compute read blocks without importing
// the codec module directly.
export { registerSpan };
