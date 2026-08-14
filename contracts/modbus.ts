// Shared contracts: canonical metric keys, register-map types and defaults.
// Used by the MQTT ingestion layer (api/) and by the frontend (register map viewer).
//
// NOTE: The vendor Modbus protocol documents for SEM2250 / SEM3250 / PEM3000 were
// not supplied with the manuals. The default maps below follow the common
// float32 input-register layout used by this class of DIN-rail meters and are
// stored in the DB as EDITABLE configuration (Device Profiles) so they can be
// corrected against the vendor protocol document without code changes.

export type RegisterType = "float32" | "u32" | "i32" | "u16" | "i16";

export interface RegisterDef {
  // Open string key — the 14 meter MetricKeys plus device-type keys
  // (see contracts/devices.ts). Alarm rules and storage accept any key.
  key: string;
  label: string;
  address: number; // register address (0-based PDU)
  functionCode: 3 | 4; // 3 = holding, 4 = input
  type: RegisterType;
  scale: number; // multiply raw value by this
  unit: string;
  // true = 32-bit values arrive with swapped 16-bit words (CDAB) — SolarEdge,
  // Growatt and several others. Decoder swaps before interpreting.
  wordSwap?: boolean;
  // Optional additive offset applied AFTER scaling: value = raw * scale + offset.
  // Needed by protocols with biased registers (e.g. ESMU/BAMS: current at
  // 0.1 A/bit with −1600 A offset, temperature at 1 °C/bit with −40 °C offset).
  offset?: number;
  // Optional plausibility bounds on the SCALED value (Wave 4 / C30 T3):
  // decodeRegisters drops out-of-range values into `rejected` instead of
  // emitting them — a wrong scale/byte-order/misaligned frame then shows up as
  // a rejection spike instead of silently wrong stored telemetry.
  min?: number; // reject decoded values below this
  max?: number; // reject decoded values above this
  // Optional per-unit address shift for multi-object devices behind one TCP
  // endpoint (e.g. ESMU/BAMS ESBCM strings: string N lives at unit N+1, block
  // base = map address + (unitId − firstUnit) × stride). The poller and the
  // simulator both apply the shift; map addresses are written for firstUnit.
  addressStride?: { firstUnit: number; stride: number };
}

// Applies the optional per-unit address shift (see RegisterDef.addressStride).
export function shiftedAddress(def: RegisterDef, unitId: number | null | undefined): number {
  const s = def.addressStride;
  if (!s || unitId == null || unitId < s.firstUnit) return def.address;
  return def.address + (unitId - s.firstUnit) * s.stride;
}

export const METRICS = [
  "voltageL1",
  "voltageL2",
  "voltageL3",
  "currentL1",
  "currentL2",
  "currentL3",
  "activePowerKw",
  "reactivePowerKvar",
  "apparentPowerKva",
  "powerFactor",
  "frequencyHz",
  "energyImportKwh",
  "energyExportKwh",
  "demandKw",
] as const;

export type MetricKey = (typeof METRICS)[number];

export const METRIC_UNITS: Record<MetricKey, string> = {
  voltageL1: "V",
  voltageL2: "V",
  voltageL3: "V",
  currentL1: "A",
  currentL2: "A",
  currentL3: "A",
  activePowerKw: "kW",
  reactivePowerKvar: "kvar",
  apparentPowerKva: "kVA",
  powerFactor: "",
  frequencyHz: "Hz",
  energyImportKwh: "kWh",
  energyExportKwh: "kWh",
  demandKw: "kW",
};

// Alarm rule metrics are open-ended strings; this list feeds the UI dropdown.
import { INVERTER_METRICS, BESS_METRICS, WEATHER_METRICS } from "./devices";

export const ALARM_METRICS = [
  ...METRICS,
  ...INVERTER_METRICS,
  ...BESS_METRICS,
  ...WEATHER_METRICS,
  "gatewayOffline",
] as const;
export type AlarmMetric = (typeof ALARM_METRICS)[number];

// Provenance of a device profile's register map (shown in UI; verify per project)
export const PROFILE_SOURCES = ["vendor", "community", "template"] as const;
export type ProfileSource = (typeof PROFILE_SOURCES)[number];

export const METER_MODELS = ["SEM2250", "SEM3250", "PEM3000"] as const;
export type MeterModel = (typeof METER_MODELS)[number];

export const GATEWAY_MODELS = ["G30", "C30"] as const;
export type GatewayModel = (typeof GATEWAY_MODELS)[number];

// ─── Default register maps ───────────────────────────────────────────────────
// Bounds (min/max, Wave 4 / C30 T3) are plausibility limits on the SCALED
// value — a misaligned decode or wrong scale is rejected, not stored.
// Voltages are L-N (0–300 V); currents cover CT-fed DIN-rail ratings
// (0–10 kA); active/reactive power stay unbounded (bidirectional, export<0).
// Three-phase float32 layout (FC04 input registers).
const threePhaseMap: RegisterDef[] = [
  { key: "voltageL1", label: "Voltage L1", address: 0x0000, functionCode: 4, type: "float32", scale: 1, unit: "V", min: 0, max: 300 },
  { key: "voltageL2", label: "Voltage L2", address: 0x0002, functionCode: 4, type: "float32", scale: 1, unit: "V", min: 0, max: 300 },
  { key: "voltageL3", label: "Voltage L3", address: 0x0004, functionCode: 4, type: "float32", scale: 1, unit: "V", min: 0, max: 300 },
  { key: "currentL1", label: "Current L1", address: 0x0006, functionCode: 4, type: "float32", scale: 1, unit: "A", min: 0, max: 10000 },
  { key: "currentL2", label: "Current L2", address: 0x0008, functionCode: 4, type: "float32", scale: 1, unit: "A", min: 0, max: 10000 },
  { key: "currentL3", label: "Current L3", address: 0x000a, functionCode: 4, type: "float32", scale: 1, unit: "A", min: 0, max: 10000 },
  { key: "activePowerKw", label: "Total active power", address: 0x0034, functionCode: 4, type: "float32", scale: 0.001, unit: "kW" },
  { key: "reactivePowerKvar", label: "Total reactive power", address: 0x003c, functionCode: 4, type: "float32", scale: 0.001, unit: "kvar" },
  { key: "apparentPowerKva", label: "Total apparent power", address: 0x0038, functionCode: 4, type: "float32", scale: 0.001, unit: "kVA", min: 0 },
  { key: "powerFactor", label: "Total power factor", address: 0x003e, functionCode: 4, type: "float32", scale: 1, unit: "", min: -1, max: 1 },
  { key: "frequencyHz", label: "Frequency", address: 0x0046, functionCode: 4, type: "float32", scale: 1, unit: "Hz", min: 40, max: 70 },
  { key: "energyImportKwh", label: "Import active energy", address: 0x0048, functionCode: 4, type: "float32", scale: 1, unit: "kWh", min: 0 },
  { key: "energyExportKwh", label: "Export active energy", address: 0x004a, functionCode: 4, type: "float32", scale: 1, unit: "kWh", min: 0 },
  { key: "demandKw", label: "Active power demand", address: 0x0054, functionCode: 4, type: "float32", scale: 0.001, unit: "kW", min: 0 },
];

// Single-phase float32 layout (FC04 input registers).
const singlePhaseMap: RegisterDef[] = [
  { key: "voltageL1", label: "Voltage", address: 0x0000, functionCode: 4, type: "float32", scale: 1, unit: "V", min: 0, max: 300 },
  { key: "currentL1", label: "Current", address: 0x0006, functionCode: 4, type: "float32", scale: 1, unit: "A", min: 0, max: 10000 },
  { key: "activePowerKw", label: "Active power", address: 0x000c, functionCode: 4, type: "float32", scale: 0.001, unit: "kW" },
  { key: "apparentPowerKva", label: "Apparent power", address: 0x0012, functionCode: 4, type: "float32", scale: 0.001, unit: "kVA", min: 0 },
  { key: "reactivePowerKvar", label: "Reactive power", address: 0x0018, functionCode: 4, type: "float32", scale: 0.001, unit: "kvar" },
  { key: "powerFactor", label: "Power factor", address: 0x001e, functionCode: 4, type: "float32", scale: 1, unit: "", min: -1, max: 1 },
  { key: "frequencyHz", label: "Frequency", address: 0x0046, functionCode: 4, type: "float32", scale: 1, unit: "Hz", min: 40, max: 70 },
  { key: "energyImportKwh", label: "Import active energy", address: 0x0048, functionCode: 4, type: "float32", scale: 1, unit: "kWh", min: 0 },
  { key: "energyExportKwh", label: "Export active energy", address: 0x004a, functionCode: 4, type: "float32", scale: 1, unit: "kWh", min: 0 },
];

export const DEFAULT_REGISTER_MAPS: Record<MeterModel, RegisterDef[]> = {
  SEM2250: singlePhaseMap,
  SEM3250: threePhaseMap,
  PEM3000: threePhaseMap,
};

export const DEFAULT_METER_PHASES: Record<MeterModel, "single" | "three"> = {
  SEM2250: "single",
  SEM3250: "three",
  PEM3000: "three",
};
