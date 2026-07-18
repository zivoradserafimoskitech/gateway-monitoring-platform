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
  key: MetricKey;
  label: string;
  address: number; // register address (0-based)
  functionCode: 3 | 4; // 3 = holding, 4 = input
  type: RegisterType;
  scale: number; // multiply raw value by this
  unit: string;
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

export const ALARM_METRICS = [...METRICS, "gatewayOffline"] as const;
export type AlarmMetric = (typeof ALARM_METRICS)[number];

export const METER_MODELS = ["SEM2250", "SEM3250", "PEM3000"] as const;
export type MeterModel = (typeof METER_MODELS)[number];

export const GATEWAY_MODELS = ["G30", "C30"] as const;
export type GatewayModel = (typeof GATEWAY_MODELS)[number];

// ─── Default register maps ───────────────────────────────────────────────────
// Three-phase float32 layout (FC04 input registers).
const threePhaseMap: RegisterDef[] = [
  { key: "voltageL1", label: "Voltage L1", address: 0x0000, functionCode: 4, type: "float32", scale: 1, unit: "V" },
  { key: "voltageL2", label: "Voltage L2", address: 0x0002, functionCode: 4, type: "float32", scale: 1, unit: "V" },
  { key: "voltageL3", label: "Voltage L3", address: 0x0004, functionCode: 4, type: "float32", scale: 1, unit: "V" },
  { key: "currentL1", label: "Current L1", address: 0x0006, functionCode: 4, type: "float32", scale: 1, unit: "A" },
  { key: "currentL2", label: "Current L2", address: 0x0008, functionCode: 4, type: "float32", scale: 1, unit: "A" },
  { key: "currentL3", label: "Current L3", address: 0x000a, functionCode: 4, type: "float32", scale: 1, unit: "A" },
  { key: "activePowerKw", label: "Total active power", address: 0x0034, functionCode: 4, type: "float32", scale: 0.001, unit: "kW" },
  { key: "reactivePowerKvar", label: "Total reactive power", address: 0x003c, functionCode: 4, type: "float32", scale: 0.001, unit: "kvar" },
  { key: "apparentPowerKva", label: "Total apparent power", address: 0x0038, functionCode: 4, type: "float32", scale: 0.001, unit: "kVA" },
  { key: "powerFactor", label: "Total power factor", address: 0x003e, functionCode: 4, type: "float32", scale: 1, unit: "" },
  { key: "frequencyHz", label: "Frequency", address: 0x0046, functionCode: 4, type: "float32", scale: 1, unit: "Hz" },
  { key: "energyImportKwh", label: "Import active energy", address: 0x0048, functionCode: 4, type: "float32", scale: 1, unit: "kWh" },
  { key: "energyExportKwh", label: "Export active energy", address: 0x004a, functionCode: 4, type: "float32", scale: 1, unit: "kWh" },
  { key: "demandKw", label: "Active power demand", address: 0x0054, functionCode: 4, type: "float32", scale: 0.001, unit: "kW" },
];

// Single-phase float32 layout (FC04 input registers).
const singlePhaseMap: RegisterDef[] = [
  { key: "voltageL1", label: "Voltage", address: 0x0000, functionCode: 4, type: "float32", scale: 1, unit: "V" },
  { key: "currentL1", label: "Current", address: 0x0006, functionCode: 4, type: "float32", scale: 1, unit: "A" },
  { key: "activePowerKw", label: "Active power", address: 0x000c, functionCode: 4, type: "float32", scale: 0.001, unit: "kW" },
  { key: "apparentPowerKva", label: "Apparent power", address: 0x0012, functionCode: 4, type: "float32", scale: 0.001, unit: "kVA" },
  { key: "reactivePowerKvar", label: "Reactive power", address: 0x0018, functionCode: 4, type: "float32", scale: 0.001, unit: "kvar" },
  { key: "powerFactor", label: "Power factor", address: 0x001e, functionCode: 4, type: "float32", scale: 1, unit: "" },
  { key: "frequencyHz", label: "Frequency", address: 0x0046, functionCode: 4, type: "float32", scale: 1, unit: "Hz" },
  { key: "energyImportKwh", label: "Import active energy", address: 0x0048, functionCode: 4, type: "float32", scale: 1, unit: "kWh" },
  { key: "energyExportKwh", label: "Export active energy", address: 0x004a, functionCode: 4, type: "float32", scale: 1, unit: "kWh" },
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
