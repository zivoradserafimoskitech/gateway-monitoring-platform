// Device-type model: the platform is meter-native but device-generic.
// A "device" (meters table) has a deviceType; each type has a canonical set of
// metric keys. Register maps (device_profiles) bind vendor models to these keys.

export const DEVICE_TYPES = ["meter", "inverter", "bess", "weather"] as const;
export type DeviceType = (typeof DEVICE_TYPES)[number];

export const DEVICE_TYPE_LABELS: Record<DeviceType, string> = {
  meter: "Energy meter",
  inverter: "PV inverter",
  bess: "Battery storage",
  weather: "Weather station",
};

// ─── Canonical metric keys per device type ───────────────────────────────────
// Meters keep the original 14 keys (contracts/modbus METRICS). The keys below
// extend the open key space for generation/storage assets. Alarm rules and
// telemetry storage accept ANY string key — these are the UI-known ones.

export const INVERTER_METRICS = [
  "dcPowerKw",
  "dcVoltageMppt1",
  "dcVoltageMppt2",
  "dcVoltageMppt3",
  "dcVoltageMppt4",
  "dcCurrentMppt1",
  "dcCurrentMppt2",
  "dcCurrentMppt3",
  "dcCurrentMppt4",
  "energyTodayKwh",
  "energyTotalKwh",
  "heatsinkTempC",
  "internalTempC",
  "statusCode",
  "faultCode",
] as const;

export const BESS_METRICS = [
  "socPercent",
  "sohPercent",
  "batteryVoltageV",
  "batteryCurrentA",
  "batteryPowerKw", // signed: + = discharging, - = charging
  "chargePowerKw",
  "dischargePowerKw",
  "chargeEnergyTodayKwh",
  "dischargeEnergyTodayKwh",
  "chargeEnergyTotalKwh",
  "dischargeEnergyTotalKwh",
  "cellTempMaxC",
  "cellTempMinC",
  "cyclesCount",
  "bmsStatusCode",
  "faultCode",
] as const;

export const WEATHER_METRICS = [
  "irradianceWm2",
  "ambientTempC",
  "moduleTempC",
  "windSpeedMs",
] as const;

// Units for the extended keys (meter keys live in METRIC_UNITS in modbus.ts)
export const EXTENDED_METRIC_UNITS: Record<string, string> = {
  dcPowerKw: "kW",
  dcVoltageMppt1: "V",
  dcVoltageMppt2: "V",
  dcVoltageMppt3: "V",
  dcVoltageMppt4: "V",
  dcCurrentMppt1: "A",
  dcCurrentMppt2: "A",
  dcCurrentMppt3: "A",
  dcCurrentMppt4: "A",
  energyTodayKwh: "kWh",
  energyTotalKwh: "kWh",
  heatsinkTempC: "°C",
  internalTempC: "°C",
  statusCode: "",
  faultCode: "",
  socPercent: "%",
  sohPercent: "%",
  batteryVoltageV: "V",
  batteryCurrentA: "A",
  batteryPowerKw: "kW",
  chargePowerKw: "kW",
  dischargePowerKw: "kW",
  chargeEnergyTodayKwh: "kWh",
  dischargeEnergyTodayKwh: "kWh",
  chargeEnergyTotalKwh: "kWh",
  dischargeEnergyTotalKwh: "kWh",
  cellTempMaxC: "°C",
  cellTempMinC: "°C",
  cyclesCount: "",
  bmsStatusCode: "",
  irradianceWm2: "W/m²",
  ambientTempC: "°C",
  moduleTempC: "°C",
  windSpeedMs: "m/s",
};

// Which key best represents "current power" per type (dashboard cards, trends)
export const PRIMARY_POWER_KEY: Record<DeviceType, string> = {
  meter: "activePowerKw",
  inverter: "activePowerKw",
  bess: "batteryPowerKw",
  weather: "irradianceWm2",
};

// Which key represents the cumulative energy counter per type (for "today" math)
export const ENERGY_COUNTER_KEY: Record<DeviceType, string> = {
  meter: "energyImportKwh",
  inverter: "energyTotalKwh",
  bess: "dischargeEnergyTotalKwh",
  weather: "irradianceWm2", // n/a — unused
};
