// D8: SunSpec Modbus device-profile pack.
//
// Seeds three profiles into device_profiles (INSERT-ONLY per model, same
// semantics as scripts/seed-profiles.ts — existing rows are never overwritten
// unless --refresh is passed):
//
//   sunspec-common          SunS marker + model 1 common header (numeric regs)
//   sunspec-inverter-103    three-phase inverter, int+SF models 103/120/123
//   sunspec-inverter-111    inverter float models 111/120/123 (drop-in)
//
// ─── Base-address assumption (READ BEFORE FIELD USE) ────────────────────────
// SunSpec maps live in one of two base blocks: 40000 or 50000 (0-based PDU;
// the SunSpec spec prints these as the starting addresses of the "SunS"
// marker). These maps are written for base **40000**: absolute PDU address of
// the marker = 40000, model 1 header at 40002–40003, model 1 points at
// 40004..40069 (L=66), then models chain by {id, length} headers:
//   40070/71 = inverter model header (103 L=50, or 111 L=60)
//   then nameplate 120 (L=26), then immediate controls 123 (L=24),
//   then the 0xFFFF end-model header.
// If a device answers illegal-address, re-scan: read 2 registers at 40000 AND
// 50000 (some vendors also use 0 or 40001-style 1-based numbering) — the
// valid base reads back 0x5375 0x6E53 ("SunS"). Address shifts with firmware
// are possible; the model header chain is authoritative, this map is the
// canonical layout template.
//
// ─── int+SF caveat (sunspec-inverter-103) ───────────────────────────────────
// Models 101/102/103 carry sunssf scale-factor registers; the true value is
// raw × 10^SF. The platform decoder (contracts/modbus.ts RegisterDef) applies
// a STATIC scale, so the 103 map stores raw mantissas under *Raw keys AND
// maps every SF register — compose them downstream (or use the 111 float
// profile, which needs no SF handling and exposes canonical keys such as
// activePowerKw directly). A future ProtocolAdapter (api/protocols/adapter.ts)
// can fold SF composition into decode().
//
// ─── Control (curtailment) ──────────────────────────────────────────────────
// Both inverter profiles declare a controllable whitelist entry
// `activePowerLimitPct` → model 123 WMaxLimPct (FC6 write). It assumes
// WMaxLimPct_SF = −2 (register = percent × 100), the overwhelmingly common
// value; VERIFY the SF register on site before curtailing. Writes go through
// api/control/execute.ts (whitelist + range + RBAC + audit) with read-back
// verification on direct-TCP devices.
//
// Usage:
//   npx tsx scripts/seed-sunspec.ts --dry-run   # validate in-memory, NO DB
//   npx tsx scripts/seed-sunspec.ts             # insert missing profiles
//   npx tsx scripts/seed-sunspec.ts --refresh   # also UPDATE existing rows
import "dotenv/config";
import type { RegisterDef } from "@contracts/modbus";
import type { ControllableMap } from "../api/control/execute";

export interface SunspecProfileEntry {
  model: string;
  label: string;
  brand: string;
  deviceType: "inverter" | "bess" | "weather" | "meter";
  protocol: "rtu" | "tcp";
  source: "vendor" | "community" | "template";
  sourceUrl?: string;
  notes?: string;
  registerMap: RegisterDef[];
  faultCodes?: Array<{ code: number; text: string }>;
  controllable?: ControllableMap;
}

// SunSpec St enum (models 103/111 operating state) — reused as faultCodes so
// the UI can decode statusCode.
const SUNSPEC_STATE_CODES = [
  { code: 1, text: "I_Status: Off" },
  { code: 2, text: "I_Status: Sleeping (night)" },
  { code: 3, text: "I_Status: Starting / grid monitoring" },
  { code: 4, text: "I_Status: Producing (MPPT)" },
  { code: 5, text: "I_Status: Throttled (curtailed)" },
  { code: 6, text: "I_Status: Shutting down" },
  { code: 7, text: "I_Status: Fault" },
  { code: 8, text: "I_Status: Standby / maintenance" },
];

// ─── Common header (base 40000, model 1) ────────────────────────────────────
// String points (Mn/Md/Opt/Vr/SN) are NOT in the register map: the platform
// decoder is numeric-only (RegisterDef.type). Their canonical offsets are
// documented in the notes for a future string-capable decoder / adapter.
const commonMap: RegisterDef[] = [
  { key: "sunspecMarkerHi", label: "SunSpec marker high word (expect 0x5375 'Su')", address: 40000, functionCode: 3, type: "u16", scale: 1, unit: "" },
  { key: "sunspecMarkerLo", label: "SunSpec marker low word (expect 0x6E53 'nS')", address: 40001, functionCode: 3, type: "u16", scale: 1, unit: "" },
  { key: "commonModelId", label: "Common model ID (expect 1)", address: 40002, functionCode: 3, type: "u16", scale: 1, unit: "" },
  { key: "commonModelLength", label: "Common model length (expect 66)", address: 40003, functionCode: 3, type: "u16", scale: 1, unit: "" },
  { key: "deviceAddress", label: "Device address (DA — Modbus unit id of this model)", address: 40068, functionCode: 3, type: "u16", scale: 1, unit: "" },
];

// ─── Model 120 nameplate (int+SF), parameterized by points base ─────────────
function nameplate120Map(base: number): RegisterDef[] {
  return [
    { key: "derType", label: "DER type (DERTyp enum: 4=PV)", address: base + 0, functionCode: 3, type: "u16", scale: 1, unit: "" },
    { key: "nameplateWRtg", label: "Active power rating (WRtg, raw ×10^WRtg_SF)", address: base + 1, functionCode: 3, type: "u16", scale: 1, unit: "W" },
    { key: "nameplateWRtgSf", label: "WRtg scale factor", address: base + 2, functionCode: 3, type: "i16", scale: 1, unit: "" },
    { key: "nameplateVaRtg", label: "Apparent power rating (VARtg, raw ×10^VARtg_SF)", address: base + 3, functionCode: 3, type: "u16", scale: 1, unit: "VA" },
    { key: "nameplateVaRtgSf", label: "VARtg scale factor", address: base + 4, functionCode: 3, type: "i16", scale: 1, unit: "" },
    { key: "nameplateARtg", label: "Current rating (ARtg, raw ×10^ARtg_SF)", address: base + 10, functionCode: 3, type: "u16", scale: 1, unit: "A" },
    { key: "nameplateARtgSf", label: "ARtg scale factor", address: base + 11, functionCode: 3, type: "i16", scale: 1, unit: "" },
    { key: "nameplateWhRtg", label: "Energy storage rating (WHRtg, raw ×10^WHRtg_SF)", address: base + 17, functionCode: 3, type: "u16", scale: 1, unit: "Wh" },
    { key: "nameplateWhRtgSf", label: "WHRtg scale factor", address: base + 18, functionCode: 3, type: "i16", scale: 1, unit: "" },
    { key: "maxChargeRateW", label: "Max charge rate (MaxChaRte, raw ×10^MaxChaRte_SF)", address: base + 21, functionCode: 3, type: "u16", scale: 1, unit: "W" },
    { key: "maxChargeRateWSf", label: "MaxChaRte scale factor", address: base + 22, functionCode: 3, type: "i16", scale: 1, unit: "" },
    { key: "maxDischargeRateW", label: "Max discharge rate (MaxDisChaRte, raw ×10^MaxDisChaRte_SF)", address: base + 23, functionCode: 3, type: "u16", scale: 1, unit: "W" },
    { key: "maxDischargeRateWSf", label: "MaxDisChaRte scale factor", address: base + 24, functionCode: 3, type: "i16", scale: 1, unit: "" },
  ];
}

// ─── Model 123 immediate controls, parameterized by points base ─────────────
function controls123Map(base: number): RegisterDef[] {
  return [
    { key: "connWinTms", label: "Connect window (Conn_WinTms)", address: base + 0, functionCode: 3, type: "u16", scale: 1, unit: "s" },
    { key: "connRvrtTms", label: "Connect revert timeout (Conn_RvrtTms)", address: base + 1, functionCode: 3, type: "u16", scale: 1, unit: "s" },
    { key: "connBitmask", label: "Connect control bitfield (Conn: bit0=connect)", address: base + 2, functionCode: 3, type: "u16", scale: 1, unit: "" },
    { key: "wMaxLimPct", label: "Max active power limit (WMaxLimPct, raw ×10^WMaxLimPct_SF)", address: base + 3, functionCode: 3, type: "u16", scale: 1, unit: "%" },
    { key: "wMaxLimPctSf", label: "WMaxLimPct scale factor (typically -2)", address: base + 4, functionCode: 3, type: "i16", scale: 1, unit: "" },
    { key: "wMaxLimPctWinTms", label: "WMaxLimPct window time", address: base + 5, functionCode: 3, type: "u16", scale: 1, unit: "s" },
    { key: "wMaxLimPctRvrtTms", label: "WMaxLimPct revert timeout", address: base + 6, functionCode: 3, type: "u16", scale: 1, unit: "s" },
    { key: "wMaxLimPctRmpTms", label: "WMaxLimPct ramp time", address: base + 7, functionCode: 3, type: "u16", scale: 1, unit: "s" },
  ];
}

function curtailmentControl(wMaxLimPctAddress: number): ControllableMap {
  return {
    activePowerLimitPct: {
      address: wMaxLimPctAddress,
      fc: 6,
      min: 0,
      max: 100,
      scale: 100, // register = percent × 100 — assumes WMaxLimPct_SF = −2
      unit: "%",
      description:
        "SunSpec 123 WMaxLimPct curtailment (0–100% of WMax). Assumes WMaxLimPct_SF = −2; verify the SF register before first use.",
    },
  };
}

// ─── Model 103 (three-phase inverter, int+SF) ───────────────────────────────
// Canonical layout, base 40000: header 40070/71 (103, L=50), points 40072..
// 40121 (47 used, padded to L), model 120 header 40122/23 → points 40124,
// model 123 header 40150/51 → points 40152, end model 0xFFFF at 40176.
const B103 = 40072;
const map103: RegisterDef[] = [
  { key: "inverterModelId", label: "Inverter model ID (expect 103)", address: 40070, functionCode: 3, type: "u16", scale: 1, unit: "" },
  { key: "inverterModelLength", label: "Inverter model length (expect 50)", address: 40071, functionCode: 3, type: "u16", scale: 1, unit: "" },
  // AC current — raw mantissas; true amps = raw × 10^currentSf
  { key: "acCurrentTotalRaw", label: "AC total current (A, raw ×10^A_SF)", address: B103 + 0, functionCode: 3, type: "i16", scale: 1, unit: "A" },
  { key: "currentL1Raw", label: "AC current L1 (AphA, raw ×10^A_SF)", address: B103 + 1, functionCode: 3, type: "i16", scale: 1, unit: "A" },
  { key: "currentL2Raw", label: "AC current L2 (AphB, raw ×10^A_SF)", address: B103 + 2, functionCode: 3, type: "i16", scale: 1, unit: "A" },
  { key: "currentL3Raw", label: "AC current L3 (AphC, raw ×10^A_SF)", address: B103 + 3, functionCode: 3, type: "i16", scale: 1, unit: "A" },
  { key: "currentSf", label: "Current scale factor (A_SF)", address: B103 + 4, functionCode: 3, type: "i16", scale: 1, unit: "" },
  // AC voltage (phase-to-neutral)
  { key: "voltageL1Raw", label: "AC voltage L1-N (PhVphA, raw ×10^V_SF)", address: B103 + 5, functionCode: 3, type: "i16", scale: 1, unit: "V" },
  { key: "voltageL2Raw", label: "AC voltage L2-N (PhVphB, raw ×10^V_SF)", address: B103 + 6, functionCode: 3, type: "i16", scale: 1, unit: "V" },
  { key: "voltageL3Raw", label: "AC voltage L3-N (PhVphC, raw ×10^V_SF)", address: B103 + 7, functionCode: 3, type: "i16", scale: 1, unit: "V" },
  { key: "voltageSf", label: "Voltage scale factor (V_SF)", address: B103 + 8, functionCode: 3, type: "i16", scale: 1, unit: "" },
  // Power / frequency
  { key: "activePowerWRaw", label: "AC active power (W, raw ×10^W_SF)", address: B103 + 9, functionCode: 3, type: "i16", scale: 1, unit: "W" },
  { key: "activePowerSf", label: "Active power scale factor (W_SF)", address: B103 + 10, functionCode: 3, type: "i16", scale: 1, unit: "" },
  { key: "frequencyHzRaw", label: "Grid frequency (Hz, raw ×10^Hz_SF)", address: B103 + 11, functionCode: 3, type: "i16", scale: 1, unit: "Hz" },
  { key: "frequencySf", label: "Frequency scale factor (Hz_SF)", address: B103 + 12, functionCode: 3, type: "i16", scale: 1, unit: "" },
  { key: "apparentPowerVaRaw", label: "AC apparent power (VA, raw ×10^VA_SF)", address: B103 + 13, functionCode: 3, type: "i16", scale: 1, unit: "VA" },
  { key: "apparentPowerSf", label: "Apparent power scale factor (VA_SF)", address: B103 + 14, functionCode: 3, type: "i16", scale: 1, unit: "" },
  { key: "reactivePowerVarRaw", label: "AC reactive power (VAr, raw ×10^VAr_SF)", address: B103 + 15, functionCode: 3, type: "i16", scale: 1, unit: "var" },
  { key: "reactivePowerSf", label: "Reactive power scale factor (VAr_SF)", address: B103 + 16, functionCode: 3, type: "i16", scale: 1, unit: "" },
  { key: "powerFactorRaw", label: "Power factor (PF, raw ×10^PF_SF)", address: B103 + 17, functionCode: 3, type: "i16", scale: 1, unit: "" },
  { key: "powerFactorSf", label: "Power factor scale factor (PF_SF)", address: B103 + 18, functionCode: 3, type: "i16", scale: 1, unit: "" },
  // Energy counter (acc32) + DC side
  { key: "energyTotalWhRaw", label: "AC lifetime energy (WH acc32, raw ×10^WH_SF)", address: B103 + 19, functionCode: 3, type: "u32", scale: 1, unit: "Wh" },
  { key: "energySf", label: "Energy scale factor (WH_SF)", address: B103 + 21, functionCode: 3, type: "i16", scale: 1, unit: "" },
  { key: "dcCurrentARaw", label: "DC current (DCA, raw ×10^DCA_SF)", address: B103 + 22, functionCode: 3, type: "i16", scale: 1, unit: "A" },
  { key: "dcCurrentSf", label: "DC current scale factor (DCA_SF)", address: B103 + 23, functionCode: 3, type: "i16", scale: 1, unit: "" },
  { key: "dcVoltageVRaw", label: "DC voltage (DCV, raw ×10^DCV_SF)", address: B103 + 24, functionCode: 3, type: "i16", scale: 1, unit: "V" },
  { key: "dcVoltageSf", label: "DC voltage scale factor (DCV_SF)", address: B103 + 25, functionCode: 3, type: "i16", scale: 1, unit: "" },
  { key: "dcPowerWRaw", label: "DC power (DCW, raw ×10^DCW_SF)", address: B103 + 26, functionCode: 3, type: "i16", scale: 1, unit: "W" },
  { key: "dcPowerSf", label: "DC power scale factor (DCW_SF)", address: B103 + 27, functionCode: 3, type: "i16", scale: 1, unit: "" },
  // Temperatures + state
  { key: "internalTempCRaw", label: "Cabinet temperature (TmpCab, raw ×10^Tmp_SF)", address: B103 + 28, functionCode: 3, type: "i16", scale: 1, unit: "°C" },
  { key: "tempSf", label: "Temperature scale factor (Tmp_SF)", address: B103 + 32, functionCode: 3, type: "i16", scale: 1, unit: "" },
  { key: "statusCode", label: "Operating state (St, SunSpec enum — see faultCodes)", address: B103 + 33, functionCode: 3, type: "u16", scale: 1, unit: "" },
  { key: "vendorStatusCode", label: "Vendor operating state (StVnd)", address: B103 + 34, functionCode: 3, type: "u16", scale: 1, unit: "" },
  { key: "eventFlags1", label: "Event bitfield 1 (Evt1, 0=ok)", address: B103 + 35, functionCode: 3, type: "u32", scale: 1, unit: "" },
  { key: "eventFlags2", label: "Event bitfield 2 (Evt2)", address: B103 + 37, functionCode: 3, type: "u32", scale: 1, unit: "" },
  // Nameplate 120 (points base 40124) + immediate controls 123 (points base 40152)
  ...nameplate120Map(40124),
  ...controls123Map(40152),
];

// ─── Model 111 (inverter, float) ────────────────────────────────────────────
// Canonical layout, base 40000: header 40070/71 (111, L=60), points 40072..
// 40131, model 120 header 40132/33 → points 40134, model 123 header 40160/61
// → points 40162, end model 0xFFFF at 40186. Float32 values decode directly —
// canonical metric keys (activePowerKw, voltageL1, ...) are safe here.
const B111 = 40072;
const map111: RegisterDef[] = [
  { key: "inverterModelId", label: "Inverter model ID (expect 111; 113 = three-phase float variant, same layout)", address: 40070, functionCode: 3, type: "u16", scale: 1, unit: "" },
  { key: "inverterModelLength", label: "Inverter model length (expect 60)", address: 40071, functionCode: 3, type: "u16", scale: 1, unit: "" },
  { key: "acCurrentTotal", label: "AC total current (A)", address: B111 + 0, functionCode: 3, type: "float32", scale: 1, unit: "A" },
  { key: "currentL1", label: "AC current L1 (AphA)", address: B111 + 2, functionCode: 3, type: "float32", scale: 1, unit: "A" },
  { key: "currentL2", label: "AC current L2 (AphB)", address: B111 + 4, functionCode: 3, type: "float32", scale: 1, unit: "A" },
  { key: "currentL3", label: "AC current L3 (AphC)", address: B111 + 6, functionCode: 3, type: "float32", scale: 1, unit: "A" },
  { key: "voltageL1L2", label: "AC voltage L1-L2 (PPVphAB)", address: B111 + 8, functionCode: 3, type: "float32", scale: 1, unit: "V" },
  { key: "voltageL2L3", label: "AC voltage L2-L3 (PPVphBC)", address: B111 + 10, functionCode: 3, type: "float32", scale: 1, unit: "V" },
  { key: "voltageL3L1", label: "AC voltage L3-L1 (PPVphCA)", address: B111 + 12, functionCode: 3, type: "float32", scale: 1, unit: "V" },
  { key: "voltageL1", label: "AC voltage L1-N (PhVphA)", address: B111 + 14, functionCode: 3, type: "float32", scale: 1, unit: "V" },
  { key: "voltageL2", label: "AC voltage L2-N (PhVphB)", address: B111 + 16, functionCode: 3, type: "float32", scale: 1, unit: "V" },
  { key: "voltageL3", label: "AC voltage L3-N (PhVphC)", address: B111 + 18, functionCode: 3, type: "float32", scale: 1, unit: "V" },
  { key: "activePowerKw", label: "AC active power (W)", address: B111 + 20, functionCode: 3, type: "float32", scale: 0.001, unit: "kW" },
  { key: "frequencyHz", label: "Grid frequency (Hz)", address: B111 + 22, functionCode: 3, type: "float32", scale: 1, unit: "Hz", min: 40, max: 70 },
  { key: "apparentPowerKva", label: "AC apparent power (VA)", address: B111 + 24, functionCode: 3, type: "float32", scale: 0.001, unit: "kVA" },
  { key: "reactivePowerKvar", label: "AC reactive power (VAr)", address: B111 + 26, functionCode: 3, type: "float32", scale: 0.001, unit: "kvar" },
  { key: "powerFactor", label: "Power factor (PF)", address: B111 + 28, functionCode: 3, type: "float32", scale: 1, unit: "", min: -1, max: 1 },
  { key: "energyTotalKwh", label: "AC lifetime energy (WH)", address: B111 + 30, functionCode: 3, type: "float32", scale: 0.001, unit: "kWh" },
  { key: "dcCurrentA", label: "DC current (DCA; single-MPPT devices only, else NaN)", address: B111 + 32, functionCode: 3, type: "float32", scale: 1, unit: "A" },
  { key: "dcVoltageV", label: "DC voltage (DCV)", address: B111 + 34, functionCode: 3, type: "float32", scale: 1, unit: "V" },
  { key: "dcPowerKw", label: "DC power (DCW)", address: B111 + 36, functionCode: 3, type: "float32", scale: 0.001, unit: "kW" },
  { key: "internalTempC", label: "Cabinet temperature (TmpCab)", address: B111 + 38, functionCode: 3, type: "float32", scale: 1, unit: "°C", min: -40, max: 125 },
  { key: "statusCode", label: "Operating state (St, SunSpec enum — see faultCodes)", address: B111 + 46, functionCode: 3, type: "u16", scale: 1, unit: "" },
  { key: "vendorStatusCode", label: "Vendor operating state (StVnd)", address: B111 + 47, functionCode: 3, type: "u16", scale: 1, unit: "" },
  { key: "eventFlags1", label: "Event bitfield 1 (Evt1, 0=ok)", address: B111 + 48, functionCode: 3, type: "u32", scale: 1, unit: "" },
  { key: "eventFlags2", label: "Event bitfield 2 (Evt2)", address: B111 + 50, functionCode: 3, type: "u32", scale: 1, unit: "" },
  // Nameplate 120 (points base 40134) + immediate controls 123 (points base 40162)
  ...nameplate120Map(40134),
  ...controls123Map(40162),
];

const COMMON_NOTES =
  "SunSpec Modbus TCP, base block 40000 (0-based PDU; alt base 50000 — scan both for the 0x5375 0x6E53 'SunS' marker). Unit id is device-specific (1 typical; some vendors use 3 or 126). Model 1 common header: ID/L at 40002-40003, then points Mn (str16, 40004-40019), Md (str16, 40020-40035), Opt (str8, 40036-40043), Vr (str8, 40044-40051), SN (str16, 40052-40067), DA (u16, 40068), Pad (40069). String points are not mapped (numeric-only decoder) — offsets documented here for a future string-capable adapter. After the common model, further models chain via {id, length} headers — the chain is authoritative; register positions may shift with firmware.";

export const SUNSPEC_PROFILES: SunspecProfileEntry[] = [
  {
    model: "sunspec-common",
    label: "SunSpec common header (SunS + model 1)",
    brand: "SunSpec",
    deviceType: "inverter",
    protocol: "tcp",
    source: "vendor",
    sourceUrl: "https://sunspec.org/sunspec-modbus-specifications/",
    notes:
      COMMON_NOTES +
      " Use this profile to verify connectivity/addressing (marker reads 0x5375/0x6E53, commonModelId=1, commonModelLength=66) before assigning an inverter model profile. Applies to ANY SunSpec device type, not only inverters.",
    registerMap: commonMap,
  },
  {
    model: "sunspec-inverter-103",
    label: "SunSpec three-phase inverter, int+SF (models 1/103/120/123)",
    brand: "SunSpec",
    deviceType: "inverter",
    protocol: "tcp",
    source: "vendor",
    sourceUrl: "https://sunspec.org/sunspec-modbus-specifications/",
    notes:
      COMMON_NOTES +
      " Model chain assumed: 1 (L=66) → 103 (L=50, header 40070, points 40072) → 120 (L=26, header 40122, points 40124) → 123 (L=24, header 40150, points 40152) → end. INT+SF CAVEAT: value registers are stored as RAW mantissas under *Raw keys with their scale factors in adjacent *Sf keys — true value = raw × 10^SF; the static-scale decoder cannot compose them. For canonical keys (activePowerKw etc.) prefer sunspec-inverter-111 (float) when the device offers it. 0x8000 (i16) / 0xFFFFFFFF (u32) = not-implemented. Control: activePowerLimitPct writes WMaxLimPct (curtailment) assuming WMaxLimPct_SF = −2 — verify on site.",
    registerMap: map103,
    faultCodes: SUNSPEC_STATE_CODES,
    controllable: curtailmentControl(40155), // 40152 + 3 (WMaxLimPct)
  },
  {
    model: "sunspec-inverter-111",
    label: "SunSpec inverter, float (models 1/111/120/123)",
    brand: "SunSpec",
    deviceType: "inverter",
    protocol: "tcp",
    source: "vendor",
    sourceUrl: "https://sunspec.org/sunspec-modbus-specifications/",
    notes:
      COMMON_NOTES +
      " Model chain assumed: 1 (L=66) → 111 (L=60, header 40070, points 40072) → 120 (L=26, header 40132, points 40134) → 123 (L=24, header 40160, points 40162) → end. FLOAT profile: float32 big-endian, no scale factors — values decode directly to canonical keys. Model 113 (three-phase float) shares this layout and length; model 112 (split-phase) populates only two phases. NaN (0x7FC00000) = not-implemented (decoder skips non-finite values). Multi-MPPT string data lives in optional model 160 (not mapped — position is firmware-dependent; scan headers). Control: activePowerLimitPct writes WMaxLimPct (curtailment).",
    registerMap: map111,
    faultCodes: SUNSPEC_STATE_CODES,
    controllable: curtailmentControl(40165), // 40162 + 3 (WMaxLimPct)
  },
];

// ─── In-memory validation (same rules as scripts/validate-profiles.ts) ──────
export function validateProfiles(entries: SunspecProfileEntry[]): { bad: number; errors: string[] } {
  let bad = 0;
  const errors: string[] = [];
  for (const p of entries) {
    const map = p.registerMap;
    if (!Array.isArray(map) || map.length === 0) {
      errors.push(`BAD ${p.model}: empty map`);
      bad++;
      continue;
    }
    const seen = new Set<string>();
    for (const d of map) {
      const ok =
        typeof d.key === "string" && d.key.length > 0 && d.key.length <= 64 &&
        Number.isInteger(d.address) && d.address >= 0 && d.address <= 65535 &&
        (d.functionCode === 3 || d.functionCode === 4) &&
        ["u16", "i16", "u32", "i32", "float32"].includes(d.type) &&
        typeof d.scale === "number" && d.scale !== 0 &&
        (d.offset === undefined || typeof d.offset === "number") &&
        (d.addressStride === undefined ||
          (Number.isInteger(d.addressStride.firstUnit) && d.addressStride.firstUnit >= 1 &&
            Number.isInteger(d.addressStride.stride) && d.addressStride.stride > 0 &&
            d.address + 19 * d.addressStride.stride <= 65535));
      if (!ok) {
        errors.push(`BAD ${p.model}: ${JSON.stringify(d)}`);
        bad++;
      } else if (seen.has(d.key)) {
        errors.push(`BAD ${p.model}: duplicate key '${d.key}'`);
        bad++;
      }
      seen.add(d.key);
    }
    // Controllable whitelist sanity (mirrors api/control/execute.ts checks).
    for (const [key, c] of Object.entries(p.controllable ?? {})) {
      const cOk =
        Number.isInteger(c.address) && c.address >= 0 && c.address <= 65535 &&
        (c.fc === undefined || c.fc === 6 || c.fc === 16) &&
        typeof c.min === "number" && typeof c.max === "number" && c.min <= c.max;
      if (!cOk) {
        errors.push(`BAD ${p.model}: controllable '${key}' ${JSON.stringify(c)}`);
        bad++;
      }
    }
  }
  return { bad, errors };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const refresh = process.argv.includes("--refresh");

  if (dryRun) {
    // No DB access: validate the definitions with the same logic the
    // post-seed validator (scripts/validate-profiles.ts) applies to rows.
    const { bad, errors } = validateProfiles(SUNSPEC_PROFILES);
    for (const e of errors) console.log(e);
    for (const p of SUNSPEC_PROFILES) {
      const span = p.registerMap.reduce(
        (acc, d) => ({ min: Math.min(acc.min, d.address), max: Math.max(acc.max, d.address) }),
        { min: Infinity, max: -Infinity },
      );
      console.log(`ok ${p.model}: ${p.registerMap.length} registers, PDU span ${span.min}..${span.max}`);
    }
    console.log(`dry-run: validated ${SUNSPEC_PROFILES.length} profiles, ${bad} bad register defs (no DB touched)`);
    process.exit(bad ? 1 : 0);
  }

  // Insert path (same insert-only semantics as scripts/seed-profiles.ts).
  const { eq } = await import("drizzle-orm");
  const { getDb } = await import("../api/queries/connection");
  const { deviceProfiles } = await import("../db/schema");
  const db = getDb();

  let inserted = 0;
  let skipped = 0;
  let updated = 0;
  for (const p of SUNSPEC_PROFILES) {
    const existing = await db.select({ id: deviceProfiles.id }).from(deviceProfiles).where(eq(deviceProfiles.model, p.model)).limit(1);
    if (existing[0]) {
      if (refresh) {
        await db.update(deviceProfiles).set({
          label: p.label,
          brand: p.brand,
          deviceType: p.deviceType,
          protocol: p.protocol,
          source: p.source,
          sourceUrl: p.sourceUrl ?? null,
          notes: p.notes ?? null,
          registerMap: p.registerMap,
          faultCodes: p.faultCodes ?? null,
          controllable: p.controllable ?? null,
        }).where(eq(deviceProfiles.model, p.model));
        updated++;
      } else {
        skipped++;
      }
      continue;
    }
    await db.insert(deviceProfiles).values({
      model: p.model,
      label: p.label,
      brand: p.brand,
      deviceType: p.deviceType,
      protocol: p.protocol,
      source: p.source,
      sourceUrl: p.sourceUrl ?? null,
      notes: p.notes ?? null,
      registerMap: p.registerMap,
      faultCodes: p.faultCodes ?? null,
      controllable: p.controllable ?? null,
    });
    inserted++;
  }
  console.log(`sunspec profiles seeded: ${inserted} inserted, ${skipped} already present (untouched)${refresh ? `, ${updated} refreshed` : ""}`);
  process.exit(0);
}

// Run ONLY when executed directly (`npx tsx scripts/seed-sunspec.ts ...`).
// Importing this module (e.g. for in-memory validation of SUNSPEC_PROFILES)
// must never touch the database.
const invokedDirectly = typeof process.argv[1] === "string" && /seed-sunspec\.ts$/.test(process.argv[1]);
if (invokedDirectly) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
