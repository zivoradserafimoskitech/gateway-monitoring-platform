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
    return decodeRegisters(map, data, baseAddress);
  },

  async control(meter: Meter, key: string, value: number): Promise<ControlResult> {
    const { executeControl } = await import("../control/execute");
    return executeControl(meter, key, value);
  },
};

registerAdapter(modbusAdapter);

// Re-exported so adapter authors can compute read blocks without importing
// the codec module directly.
export { registerSpan };
