import { sql } from "drizzle-orm";
import {
  mysqlTable,
  mysqlEnum,
  serial,
  varchar,
  timestamp,
  bigint,
  int,
  tinyint,
  double,
  boolean,
  json,
  text,
  index,
  uniqueIndex,
  primaryKey,
} from "drizzle-orm/mysql-core";

// ─── Sites ───────────────────────────────────────────────────────────────────
export const sites = mysqlTable(
  "sites",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    address: varchar("address", { length: 500 }),
    // v7/C8: IANA timezone — site-scope reports bucket days at LOCAL midnight
    // (DST handled per day via Intl-computed boundaries).
    timezone: varchar("timezone", { length: 64 }).notNull().default("UTC"),
    // v8/D2: owning org.
    orgId: bigint("org_id", { mode: "number", unsigned: true }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("sites_org_idx").on(t.orgId)],
);
export type Site = typeof sites.$inferSelect;
export type InsertSite = typeof sites.$inferInsert;

// ─── Gateways (Enertrek G30 / C30) ───────────────────────────────────────────
export const gateways = mysqlTable(
  "gateways",
  {
    id: serial("id").primaryKey(),
    // UID = IMEI for C30 (4G), Gateway ID for G30
    uid: varchar("uid", { length: 64 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    // G30 | C30 | TCP (system row for direct Modbus-TCP devices, no hardware)
    model: varchar("model", { length: 16 }).notNull(),
    // json = G30 structured JSON uplink; transparent = C30 raw Modbus passthrough;
    // tcp = direct-polled devices (no frames flow through this row)
    transport: varchar("transport", { length: 16 }).notNull(),
    siteId: bigint("site_id", { mode: "number", unsigned: true }),
    // MQTT uplink topic prefix, e.g. matis/gateway/pVariable or d2g
    topicPrefix: varchar("topic_prefix", { length: 255 }).notNull(),
    status: mysqlEnum("status", ["online", "offline"]).notNull().default("offline"),
    lastSeenAt: timestamp("last_seen_at"),
    rssi: int("rssi"),
    firmware: varchar("firmware", { length: 64 }),
    // v8/D5: device management — reported firmware version (set on firmware
    // OTA ack) and config revision (bumped on every acked config push).
    firmwareVersion: text("firmware_version"),
    configVersion: int("config_version").notNull().default(1),
    // v8/D2: owning org.
    orgId: bigint("org_id", { mode: "number", unsigned: true }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("gateways_uid_unique").on(t.uid), index("gateways_site_idx").on(t.siteId), index("gateways_org_idx").on(t.orgId)],
);
export type Gateway = typeof gateways.$inferSelect;
export type InsertGateway = typeof gateways.$inferInsert;

// ─── Devices (meters, PV inverters, BESS, weather stations) ──────────────────
// Historically "meters" — generalized to any Modbus device. `model` is the key
// into device_profiles (register maps); `deviceType` drives UI + semantics.
// Direct Modbus-TCP devices (no gateway) carry host/port/unitId and are polled
// by api/poller; bus devices keep gatewayId + modbusAddress as before.
export const meters = mysqlTable(
  "meters",
  {
    id: serial("id").primaryKey(),
    gatewayId: bigint("gateway_id", { mode: "number", unsigned: true }).notNull(),
    // v6/R7: direct Modbus-TCP devices hang off the synthetic "direct-tcp"
    // gateway (site_id null) and could never be assigned to a plant/site.
    // Effective site = coalesce(meters.site_id, gateways.site_id).
    siteId: bigint("site_id", { mode: "number", unsigned: true }),
    name: varchar("name", { length: 255 }).notNull(),
    model: varchar("model", { length: 128 }).notNull(),
    // §9.4 emergency stop: while set, EVERY write to this device is refused —
    // manual control and all four automatic writers (grid limit, peak shaving,
    // plans, schedules) plus the watchdog. Enforced at executeControl, the one
    // chokepoint they all pass through, so a controller added later inherits
    // the lock instead of having to remember it.
    controlLockedAt: timestamp("control_locked_at"),
    controlLockedBy: bigint("control_locked_by", { mode: "number", unsigned: true }),
    controlLockReason: varchar("control_lock_reason", { length: 255 }),
    deviceType: varchar("device_type", { length: 32 }).notNull().default("meter"),
    brand: varchar("brand", { length: 64 }),
    phases: mysqlEnum("phases", ["single", "three"]).notNull().default("three"),
    modbusAddress: int("modbus_address").notNull(),
    channel: int("channel").notNull().default(1),
    // Direct Modbus TCP (poller-managed); null = reached via gateway bus.
    // For TCP devices, modbusAddress is a synthetic unique slot and unitId
    // holds the real Modbus unit identifier (usually 1).
    host: varchar("host", { length: 255 }),
    port: int("port"),
    unitId: int("unit_id"),
    pollIntervalSec: int("poll_interval_sec").notNull().default(60),
    status: mysqlEnum("status", ["online", "offline"]).notNull().default("offline"),
    lastSeenAt: timestamp("last_seen_at"),
    // v8/D2: owning org.
    orgId: bigint("org_id", { mode: "number", unsigned: true }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("meters_gateway_idx").on(t.gatewayId),
    index("meters_site_idx").on(t.siteId),
    index("meters_org_idx").on(t.orgId),
    uniqueIndex("meters_gw_addr_unique").on(t.gatewayId, t.modbusAddress),
  ],
);
export type Meter = typeof meters.$inferSelect;
export type InsertMeter = typeof meters.$inferInsert;

// ─── Telemetry (time series) ─────────────────────────────────────────────────
export const telemetry = mysqlTable(
  "telemetry",
  {
    id: serial("id").primaryKey(),
    meterId: bigint("meter_id", { mode: "number", unsigned: true }).notNull(),
    ts: timestamp("ts").notNull().defaultNow(),
    voltageL1: double("voltage_l1"),
    voltageL2: double("voltage_l2"),
    voltageL3: double("voltage_l3"),
    currentL1: double("current_l1"),
    currentL2: double("current_l2"),
    currentL3: double("current_l3"),
    activePowerKw: double("active_power_kw"),
    reactivePowerKvar: double("reactive_power_kvar"),
    apparentPowerKva: double("apparent_power_kva"),
    powerFactor: double("power_factor"),
    frequencyHz: double("frequency_hz"),
    energyImportKwh: double("energy_import_kwh"),
    energyExportKwh: double("energy_export_kwh"),
    demandKw: double("demand_kw"),
    // Full decoded register map (open keys: inverter/BESS/weather metrics too).
    // The 14 fixed columns above stay for fast fleet/report queries on meters.
    valuesJson: json("values_json"),
    raw: json("raw"),
  },
  (t) => [index("telemetry_meter_ts_idx").on(t.meterId, t.ts)],
);
export type Telemetry = typeof telemetry.$inferSelect;
export type InsertTelemetry = typeof telemetry.$inferInsert;

// ─── v7/C5: hourly downsampled telemetry ─────────────────────────────────────
// Raw rows are purged after TELEMETRY_RAW_DAYS; reports for older days read
// these hourly aggregates. Energy is stored BOTH as intra-hour non-negative
// delta sum (counter-reset safe) and as first/last counter values so the
// report query can add the inter-hour deltas via lag().
export const telemetryHourly = mysqlTable(
  "telemetry_hourly",
  {
    id: serial("id").primaryKey(),
    meterId: bigint("meter_id", { mode: "number", unsigned: true }).notNull(),
    hourStart: timestamp("hour_start").notNull(),
    samples: int("samples").notNull(),
    avgPowerKw: double("avg_power_kw"),
    maxPowerKw: double("max_power_kw"),
    maxDemandKw: double("max_demand_kw"),
    demandSamples: int("demand_samples").notNull().default(0),
    avgPowerFactor: double("avg_power_factor"),
    energyImportDeltaKwh: double("energy_import_delta_kwh"),
    energyExportDeltaKwh: double("energy_export_delta_kwh"),
    energyImportFirst: double("energy_import_first"),
    energyImportLast: double("energy_import_last"),
    energyExportFirst: double("energy_export_first"),
    energyExportLast: double("energy_export_last"),
    counterReset: int("counter_reset").notNull().default(0),
    // Chart series that survive the raw-retention cutoff. batteryPowerKw and
    // irradianceWm2 live in values_json rather than in a telemetry column, but
    // they are the PRIMARY_POWER_KEY for BESS and weather devices, so without
    // them those charts go empty past the cutoff while a meter's does not.
    avgVoltageL1: double("avg_voltage_l1"),
    avgCurrentL1: double("avg_current_l1"),
    avgFrequencyHz: double("avg_frequency_hz"),
    avgBatteryPowerKw: double("avg_battery_power_kw"),
    avgIrradianceWm2: double("avg_irradiance_wm2"),
  },
  (t) => [uniqueIndex("telemetry_hourly_meter_hour_idx").on(t.meterId, t.hourStart)],
);
export type TelemetryHourly = typeof telemetryHourly.$inferSelect;

// ─── Alarm rules ─────────────────────────────────────────────────────────────
export const alarmRules = mysqlTable(
  "alarm_rules",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    // metric key, e.g. voltageL1, activePowerKw, frequencyHz, powerFactor, gatewayOffline
    metric: varchar("metric", { length: 64 }).notNull(),
    // gt/lt compare the value against `threshold`. "stuck" is §9.7 data
    // quality: the value has not CHANGED for `threshold` seconds, which is the
    // failure the other two are blind to — a frozen register stays inside its
    // limits forever while the device reports as perfectly healthy.
    operator: mysqlEnum("operator", ["gt", "lt", "stuck"]).notNull(),
    // For gt/lt a value in the metric's own unit; for "stuck", seconds.
    threshold: double("threshold").notNull(),
    severity: mysqlEnum("severity", ["info", "warning", "critical"]).notNull().default("warning"),
    // null meterId => applies to all meters
    meterId: bigint("meter_id", { mode: "number", unsigned: true }),
    // "breached for N seconds" before raising. 0 = raise on the first sample.
    // A single noisy sample over the threshold is almost never worth waking
    // somebody for; this is what makes a jittery signal usable.
    durationSec: int("duration_sec").notNull().default(0),
    enabled: boolean("enabled").notNull().default(true),
    // v8/D2: owning org.
    orgId: bigint("org_id", { mode: "number", unsigned: true }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("alarm_rules_org_idx").on(t.orgId)],
);
export type AlarmRule = typeof alarmRules.$inferSelect;
export type InsertAlarmRule = typeof alarmRules.$inferInsert;

// §9.2: grid connection limit per site.
//
// A connection agreement caps import and, more often the binding one, export.
// Breaching it is a contractual and often regulatory event, so the limit has
// to hold without a human watching. One row per site; the controller reads it
// on every EMS tick.
export const gridLimits = mysqlTable(
  "grid_limits",
  {
    id: serial("id").primaryKey(),
    siteId: bigint("site_id", { mode: "number", unsigned: true }).notNull(),
    // Meter at the point of common coupling — the one that actually sees what
    // crosses the boundary. Its activePowerKw is signed: + import, − export.
    pccMeterId: bigint("pcc_meter_id", { mode: "number", unsigned: true }).notNull(),
    maxImportKw: double("max_import_kw"),
    // Positive magnitude, not a negative number: "export at most 100 kW".
    maxExportKw: double("max_export_kw"),
    // Release only this far inside the limit, so the loop does not hunt.
    deadbandKw: double("deadband_kw").notNull().default(5),
    // Ceiling on how far the total curtailment moves in one tick, so a single
    // wild reading cannot take a whole array offline at once.
    maxStepKw: double("max_step_kw").notNull().default(25),
    // Durable total curtailment in kW. Curtailing changes the measurement that
    // asked for it, so the controller holds this and nudges it rather than
    // recomputing from each reading — and it must survive a restart, or the
    // site un-curtails the moment the process bounces.
    curtailKw: double("curtail_kw").notNull().default(0),
    enabled: boolean("enabled").notNull().default(true),
    orgId: bigint("org_id", { mode: "number", unsigned: true }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (t) => [uniqueIndex("grid_limits_site_unique").on(t.siteId), index("grid_limits_org_idx").on(t.orgId)],
);
export type GridLimitRow = typeof gridLimits.$inferSelect;

// Which assets may be curtailed for that site, and in what order. Lower
// priority curtails first — the column exists so an operator can put a leased
// array ahead of an owned one and have that obeyed rather than averaged away.
export const curtailmentAssets = mysqlTable(
  "curtailment_assets",
  {
    id: serial("id").primaryKey(),
    siteId: bigint("site_id", { mode: "number", unsigned: true }).notNull(),
    meterId: bigint("meter_id", { mode: "number", unsigned: true }).notNull(),
    priority: int("priority").notNull().default(100),
    // Nameplate kW: the denominator when the limit register is a percentage.
    ratedKw: double("rated_kw").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("curtail_asset_site_meter_unique").on(t.siteId, t.meterId),
    index("curtail_asset_site_idx").on(t.siteId),
  ],
);
export type CurtailmentAsset = typeof curtailmentAssets.$inferSelect;

// §9.8: targeted alarm suppression, with a reason.
//
// Maintenance windows already silence a whole SITE for a period. What was
// missing is the narrow case that actually comes up: one rule, or one device,
// is known to be misbehaving and should stop paging people while it is fixed —
// without going dark on everything else at that site.
//
// Deliberately different from a maintenance window in one respect: a suppressed
// alarm is still RAISED and still appears in history, carrying the reason it
// was not sent. A maintenance window blocks the alarm outright, which loses the
// record that the condition ever happened. Suppression means "do not wake
// anyone", not "pretend it did not occur".
export const alarmSuppressions = mysqlTable(
  "alarm_suppressions",
  {
    id: serial("id").primaryKey(),
    // What is silenced: one rule, one device, or one site.
    scope: mysqlEnum("scope", ["rule", "meter", "site"]).notNull(),
    refId: bigint("ref_id", { mode: "number", unsigned: true }).notNull(),
    startsAt: timestamp("starts_at").notNull(),
    endsAt: timestamp("ends_at").notNull(),
    // NOT nullable: a suppression with no reason is how an installation ends
    // up permanently quiet with nobody remembering why.
    reason: varchar("reason", { length: 255 }).notNull(),
    createdBy: bigint("created_by", { mode: "number", unsigned: true }),
    orgId: bigint("org_id", { mode: "number", unsigned: true }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("alarm_supp_scope_idx").on(t.scope, t.refId), index("alarm_supp_org_idx").on(t.orgId)],
);
export type AlarmSuppression = typeof alarmSuppressions.$inferSelect;

// §9.8: who is on duty. Without a rota every channel receives everything at
// every hour, which is how a 3 a.m. page reaches six people who cannot act on
// it and one who can.
//
// Opt-in by construction: when an org has NO shifts configured, dispatch is
// unchanged and every channel is notified. A rota that quietly pages nobody
// because it was half-configured is worse than no rota at all.
export const onCallShifts = mysqlTable(
  "on_call_shifts",
  {
    id: serial("id").primaryKey(),
    channelId: bigint("channel_id", { mode: "number", unsigned: true }).notNull(),
    // Same shape as ems_schedules: bit 0 = Sunday.
    dayOfWeekMask: int("day_of_week_mask").notNull().default(127),
    startMin: int("start_min").notNull().default(0),
    // Equal start and end means all day; end < start wraps past midnight,
    // which is what a night shift is.
    endMin: int("end_min").notNull().default(0),
    // The rota is read in a human's local time, not the server's.
    timezone: varchar("timezone", { length: 64 }).notNull().default("UTC"),
    enabled: boolean("enabled").notNull().default(true),
    orgId: bigint("org_id", { mode: "number", unsigned: true }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("on_call_channel_idx").on(t.channelId), index("on_call_org_idx").on(t.orgId)],
);
export type OnCallShift = typeof onCallShifts.$inferSelect;

// ─── Alarm events ────────────────────────────────────────────────────────────
export const alarms = mysqlTable(
  "alarms",
  {
    id: serial("id").primaryKey(),
    ruleId: bigint("rule_id", { mode: "number", unsigned: true }),
    meterId: bigint("meter_id", { mode: "number", unsigned: true }),
    gatewayId: bigint("gateway_id", { mode: "number", unsigned: true }),
    metric: varchar("metric", { length: 64 }).notNull(),
    value: double("value"),
    threshold: double("threshold"),
    severity: mysqlEnum("severity", ["info", "warning", "critical"]).notNull().default("warning"),
    message: varchar("message", { length: 500 }).notNull(),
    status: mysqlEnum("status", ["active", "acknowledged", "resolved"]).notNull().default("active"),
    // §9.8: set when a suppression stopped this alarm being dispatched. The
    // alarm is still here — the record of the condition is not the thing
    // anyone wanted silenced.
    suppressedReason: varchar("suppressed_reason", { length: 255 }),
    triggeredAt: timestamp("triggered_at").notNull().defaultNow(),
    acknowledgedAt: timestamp("acknowledged_at"),
    resolvedAt: timestamp("resolved_at"),
    // v5 #7: race-proof alarm dedup. While an alarm is active/acknowledged this
    // generated key holds rule:meter:gateway:metric; resolving NULLs it (MySQL
    // allows many NULLs in a unique index). Concurrent evaluators can't insert
    // the same ongoing condition twice — the second insert hits the unique
    // index and is treated as "already fired".
    activeDedupKey: varchar("active_dedup_key", { length: 100 }).generatedAlwaysAs(
      sql`(case when status in ('active','acknowledged') then concat(coalesce(rule_id,0), ':', coalesce(meter_id,0), ':', coalesce(gateway_id,0), ':', metric) else null end)`,
    ),
  },
  (t) => [
    index("alarms_status_idx").on(t.status),
    index("alarms_meter_idx").on(t.meterId),
    uniqueIndex("alarms_active_dedup_uniq").on(t.activeDedupKey),
  ],
);
export type Alarm = typeof alarms.$inferSelect;
export type InsertAlarm = typeof alarms.$inferInsert;

// ─── Device profiles: editable Modbus register maps per device model ─────────
// `model` is the unique key referenced by meters.model (e.g. "SEM3250",
// "huawei-sun2000"). Maps are editable configuration — correct per project
// against the vendor protocol document. `source` records provenance.
export const deviceProfiles = mysqlTable(
  "device_profiles",
  {
    id: serial("id").primaryKey(),
    model: varchar("model", { length: 128 }).notNull(),
    label: varchar("label", { length: 255 }).notNull(),
    brand: varchar("brand", { length: 64 }),
    deviceType: varchar("device_type", { length: 32 }).notNull().default("meter"),
    protocol: varchar("protocol", { length: 16 }).notNull().default("rtu"), // rtu | tcp
    source: varchar("source", { length: 32 }).notNull().default("template"), // vendor | community | template
    sourceUrl: varchar("source_url", { length: 500 }),
    notes: text("notes"),
    // Array of { key, label, address, functionCode, type, scale, unit, wordSwap? }
    registerMap: json("register_map").notNull(),
    // Optional fault/alarm code decoding table: [{ code, text }]
    faultCodes: json("fault_codes"),
    // v7/C12: writable-register whitelist. { [key]: { address, fc?, min, max,
    // scale?, unit?, description? } } — ONLY keys listed here can be written
    // via control.execute; everything else is rejected before any bus traffic.
    controllable: json("controllable"),
    // Wave 5 / T1: verification status gates CONTROL (writes). draft =
    // register map not yet verified against real hardware → executeControl
    // refuses writes (reads stay allowed — that is how you verify).
    // bench_verified is earned via the bench-verification workflow (Task 3);
    // field_verified is set manually after live-site runtime.
    verificationStatus: mysqlEnum("verification_status", ["draft", "bench_verified", "field_verified"])
      .notNull()
      .default("draft"),
    verifiedBy: bigint("verified_by", { mode: "number", unsigned: true }),
    verifiedAt: timestamp("verified_at"),
    // Firmware version, serial, what was tested.
    verifiedNotes: text("verified_notes"),
    // Vendor document + revision the map came from (required on import, T2).
    sourceDocument: varchar("source_document", { length: 500 }),
    // Commissioning escape hatch (admin-only): allows writes to a DRAFT
    // profile, but every write is logged with a visible WARNING marker.
    allowUnverifiedControl: boolean("allow_unverified_control").notNull().default(false),
    // Setpoint deadman: { key, value, intervalMs, deviceTimeoutMs }. `key` must
    // name an entry in `controllable`. When present, the EMS controller
    // refreshes that register while it manages the device, so losing the
    // platform makes the device fall back to its own safe state instead of
    // holding the last setpoint forever. NULL = no watchdog (current
    // behaviour for every existing profile). The address, value and the
    // device's timeout are per-model facts established on a bench, which is
    // why they are configuration rather than code.
    watchdog: json("watchdog"),
    // Wave 5 / T3: sign convention recorded during bench verification —
    // true = batteryPowerKw reads POSITIVE while discharging, false = negative,
    // NULL = never recorded (blocks bench_verified for profiles that have a
    // controllable power setpoint).
    dischargePositive: boolean("discharge_positive"),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("device_profiles_model_unique").on(t.model)],
);
export type DeviceProfile = typeof deviceProfiles.$inferSelect;
export type InsertDeviceProfile = typeof deviceProfiles.$inferInsert;

// ─── Downlink command log ────────────────────────────────────────────────────
export const commands = mysqlTable(
  "commands",
  {
    id: serial("id").primaryKey(),
    gatewayId: bigint("gateway_id", { mode: "number", unsigned: true }).notNull(),
    meterId: bigint("meter_id", { mode: "number", unsigned: true }),
    kind: varchar("kind", { length: 64 }).notNull(), // readNow | custom | control
    payloadHex: varchar("payload_hex", { length: 2048 }).notNull(),
    topic: varchar("topic", { length: 255 }).notNull(),
    status: mysqlEnum("status", ["sent", "ok", "failed"]).notNull().default("sent"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    // v7/C12 control rows: who wrote what, and how it ended. For kind=control
    // topic carries "control:<model>" and payloadHex the actual FC6 frame.
    userId: bigint("user_id", { mode: "number", unsigned: true }),
    controlKey: varchar("control_key", { length: 64 }),
    controlValue: double("control_value"),
    result: varchar("result", { length: 500 }),
    // Wave 4 / C30 T1: Modbus request parameters for kind=readNow rows (one row
    // per read block). A C30 response carries no start address — these columns
    // make the request recoverable so the response is decoded against a KNOWN
    // base instead of a guessed one. respondedAt stamps the correlated reply.
    reqSlave: int("req_slave"),
    reqFc: int("req_fc"),
    reqStart: int("req_start"),
    reqQuantity: int("req_quantity"),
    respondedAt: timestamp("responded_at"),
  },
  (t) => [index("commands_gateway_idx").on(t.gatewayId), index("commands_meter_idx").on(t.meterId)],
);
export type Command = typeof commands.$inferSelect;
export type InsertCommand = typeof commands.$inferInsert;

// ─── Multi-tenancy (v8 D2) ───────────────────────────────────────────────────
// Every tenant-owned row carries org_id (backfilled to "Default Org"). The
// superadmin (users.is_superadmin) sees all orgs; everyone else only their own.
// Login throttling, shared across replicas. Per-process counters multiplied
// the brute-force budget by the replica count: five attempts each, not five in
// total. Keyed by identity ("id:<email>") AND source ("ip:<addr>"); a login is
// rejected when either key is locked.
export const loginAttempts = mysqlTable(
  "login_attempts",
  {
    // "id:<email>" or "ip:<addr>".
    attemptKey: varchar("attempt_key", { length: 160 }).primaryKey(),
    // Epoch-millisecond timestamps of failures inside the rolling window.
    failures: json("failures").notNull(),
    lockedUntil: timestamp("locked_until"),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (t) => [index("login_attempts_updated_idx").on(t.updatedAt)],
);

// Pending multi-factor challenges, shared across replicas. Per-process state
// failed the second factor outright whenever the code was submitted to a
// different replica than the one that issued the challenge.
export const mfaPendingChallenges = mysqlTable(
  "mfa_pending",
  {
    token: varchar("token", { length: 64 }).primaryKey(),
    userId: bigint("user_id", { mode: "number", unsigned: true }).notNull(),
    attempts: int("attempts").notNull().default(0),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("mfa_pending_created_idx").on(t.createdAt)],
);

// Alarm hysteresis, shared across replicas. MQTT ingestion is deliberately NOT
// leased — the shared subscription balances it on purpose — so two replicas
// evaluate the same rules. With per-process state each kept its own view, so a
// breach could be raised twice or a clear missed entirely.
//
// `since` is the instant the condition STARTED, which is also what a
// "breached for N minutes" rule needs, and it has to survive a restart.
export const alarmBreachState = mysqlTable(
  "alarm_breach_state",
  {
    ruleId: bigint("rule_id", { mode: "number", unsigned: true }).notNull(),
    meterId: bigint("meter_id", { mode: "number", unsigned: true }).notNull(),
    breached: boolean("breached").notNull().default(false),
    since: timestamp("since"),
    // Set once the rule has actually fired, so a duration rule does not raise
    // repeatedly while the condition persists.
    raisedAt: timestamp("raised_at"),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (t) => [primaryKey({ columns: [t.ruleId, t.meterId] })],
);

// Single-writer leases (api/lib/leader.ts). Exactly one replica at a time may
// run a loop that commands plant; a replica that dies stops renewing and
// another takes over once the lease lapses.
export const leaderLeases = mysqlTable("leader_leases", {
  name: varchar("name", { length: 64 }).primaryKey(),
  holder: varchar("holder", { length: 128 }).notNull(),
  expiresAt: timestamp("expires_at").notNull(),
});

// §1.4: which tenant a self-announcing device belongs to.
//
// MQTT ingestion is a shared subscription, so the broker's authenticated
// publisher identity never reaches us — a device that speaks for the first
// time is just a UID on a topic. Serial numbers are known before hardware
// ships, so an admin registers the UID in advance and the gateway is stamped
// with that org the moment it appears. Without a registration the device still
// lands unclaimed (orgs.unclaimedDevices), which is the honest outcome:
// guessing a tenant is worse than showing the device in a queue.
export const deviceRegistrations = mysqlTable(
  "device_registrations",
  {
    id: serial("id").primaryKey(),
    // Gateway UID (IMEI for C30, Gateway ID for G30) — same width as gateways.uid.
    uid: varchar("uid", { length: 64 }).notNull(),
    orgId: bigint("org_id", { mode: "number", unsigned: true }).notNull(),
    // Optional: also place the gateway at a site on arrival.
    siteId: bigint("site_id", { mode: "number", unsigned: true }),
    note: varchar("note", { length: 255 }),
    createdBy: bigint("created_by", { mode: "number", unsigned: true }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    // Stamped when the hardware actually turned up, so the list shows which
    // registrations are still outstanding.
    claimedAt: timestamp("claimed_at"),
    gatewayId: bigint("gateway_id", { mode: "number", unsigned: true }),
  },
  // One registration per UID: two rows claiming the same device for different
  // tenants is the one state this table must not be able to reach.
  (t) => [uniqueIndex("device_reg_uid_unique").on(t.uid), index("device_reg_org_idx").on(t.orgId)],
);
export type DeviceRegistration = typeof deviceRegistrations.$inferSelect;

export const orgs = mysqlTable(
  "orgs",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    // §9.14: per-tenant raw telemetry retention. NULL means "use the
    // deployment default" (TELEMETRY_RAW_DAYS), which is what every existing
    // org keeps. A tenant under a regulator that requires five years of
    // interval data and one that wants nothing kept past a month cannot both
    // be served by a single global number.
    telemetryRawDays: int("telemetry_raw_days"),
    // §9.14: the deletion path. Scheduled rather than immediate on purpose —
    // an irreversible delete of a tenant's entire history, executed the
    // instant somebody clicks, has no way back from a misclick. The grace
    // period is the feature; cancelling during it is a supported action.
    deletionRequestedAt: timestamp("deletion_requested_at"),
    deletionRequestedBy: bigint("deletion_requested_by", { mode: "number", unsigned: true }),
    deletionScheduledFor: timestamp("deletion_scheduled_for"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("orgs_name_unique").on(t.name)],
);
export type Org = typeof orgs.$inferSelect;
export type InsertOrg = typeof orgs.$inferInsert;

// ─── Auth & RBAC (v7 C1) ─────────────────────────────────────────────────────
export const users = mysqlTable(
  "users",
  {
    id: serial("id").primaryKey(),
    email: varchar("email", { length: 255 }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    // scrypt hash: "scrypt:<saltHex>:<hashHex>" — no external deps
    passwordHash: varchar("password_hash", { length: 255 }).notNull(),
    role: mysqlEnum("role", ["admin", "operator", "viewer"]).notNull().default("viewer"),
    disabled: int("disabled").notNull().default(0), // 0 active, 1 disabled
    // v8/D2: home org; isSuperadmin sees/manages all orgs.
    orgId: bigint("org_id", { mode: "number", unsigned: true }),
    isSuperadmin: boolean("is_superadmin").notNull().default(false),
    // audit #23: opt-in TOTP MFA. Secret is AES-256-GCM encrypted at rest
    // (api/lib/totp.ts); plaintext never touches the DB.
    totpSecretEnc: varchar("totp_secret_enc", { length: 255 }),
    totpEnabled: tinyint("totp_enabled").notNull().default(0), // 0 off, 1 on
    // audit wave4: last accepted TOTP time-step — replay protection. A step
    // <= totpLastStep is never accepted again (see verifyTotp in api/lib/totp.ts).
    totpLastStep: bigint("totp_last_step", { mode: "number" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("users_email_unique").on(t.email), index("users_org_idx").on(t.orgId)],
);
export type User = typeof users.$inferSelect;
export type InsertUser = typeof users.$inferInsert;

export const sessions = mysqlTable(
  "sessions",
  {
    id: serial("id").primaryKey(),
    // sha256 hex of the bearer token — the raw token only lives in the cookie
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    userId: bigint("user_id", { mode: "number", unsigned: true }).notNull(),
    expiresAt: timestamp("expires_at").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("sessions_token_unique").on(t.tokenHash), index("sessions_user_idx").on(t.userId)],
);
export type Session = typeof sessions.$inferSelect;
export type InsertSession = typeof sessions.$inferInsert;

export const auditLog = mysqlTable(
  "audit_log",
  {
    id: serial("id").primaryKey(),
    userId: bigint("user_id", { mode: "number", unsigned: true }),
    email: varchar("email", { length: 255 }),
    procedure: varchar("procedure", { length: 128 }).notNull(),
    // short human digest of the mutation input (no secrets)
    summary: varchar("summary", { length: 500 }),
    // Acting user's org — without it a per-tenant audit view is impossible.
    orgId: bigint("org_id", { mode: "number", unsigned: true }),
    // Source of the call. Anything that commands plant must be attributable to
    // an address, not just an account.
    ip: varchar("ip", { length: 45 }),
    userAgent: varchar("user_agent", { length: 255 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("audit_created_idx").on(t.createdAt), index("audit_org_idx").on(t.orgId)],
);
export type AuditLogRow = typeof auditLog.$inferSelect;

// ─── MFA backup codes (audit #23) ────────────────────────────────────────────
// Single-use recovery codes for TOTP login. Only the sha256 hash is stored;
// the raw codes are shown exactly once at setup/regeneration (same discipline
// as API keys). usedAt NULL = still redeemable.
export const mfaBackupCodes = mysqlTable(
  "mfa_backup_codes",
  {
    id: serial("id").primaryKey(),
    userId: bigint("user_id", { mode: "number", unsigned: true }).notNull(),
    // sha256 hex of the normalized code (format xxxx-xxxx)
    codeHash: varchar("code_hash", { length: 64 }).notNull(),
    usedAt: timestamp("used_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("mfa_backup_user_idx").on(t.userId)],
);
export type MfaBackupCode = typeof mfaBackupCodes.$inferSelect;
export type InsertMfaBackupCode = typeof mfaBackupCodes.$inferInsert;

// ─── Public REST API keys (v7 C11) ───────────────────────────────────────────
// Bearer keys for /api/v1/*. Only the sha256 hash is stored; the raw key is
// shown exactly once at creation (same discipline as session tokens).
export const apiKeys = mysqlTable(
  "api_keys",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    // sha256 hex of the raw key (format etk_<48 hex>)
    keyHash: varchar("key_hash", { length: 64 }).notNull(),
    // first 12 chars of the raw key — identifies the key in the UI without
    // exposing it (like GitHub's token prefixes)
    prefix: varchar("prefix", { length: 16 }).notNull(),
    role: mysqlEnum("role", ["admin", "operator", "viewer"]).notNull().default("viewer"),
    createdBy: bigint("created_by", { mode: "number", unsigned: true }),
    // v8/D2: owning org — REST reads are scoped to it.
    orgId: bigint("org_id", { mode: "number", unsigned: true }),
    lastUsedAt: timestamp("last_used_at"),
    revokedAt: timestamp("revoked_at"),
    // audit P1-7: optional key expiry (NULL = never expires) and scope
    // restriction. audit wave 4: NULL scopes = READ-ONLY (legacy keys); the
    // full scope vocabulary is "read" | "control" | "telemetry:read" |
    // "ems:write" — see api/rest/v1.ts and docs/api-v1.md.
    expiresAt: timestamp("expires_at"),
    scopes: json("scopes").$type<string[]>(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("api_keys_hash_unique").on(t.keyHash), index("api_keys_org_idx").on(t.orgId)],
);
export type ApiKey = typeof apiKeys.$inferSelect;
export type InsertApiKey = typeof apiKeys.$inferInsert;

// ─── Alarm notifications (v7 C2) ─────────────────────────────────────────────
export const notificationChannels = mysqlTable(
  "notification_channels",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    // webhook = POST JSON to target URL (also serves the public-API webhook
    // integration, v7 C11); telegram = bot "token:chatId"; email = SMTP env
    type: mysqlEnum("type", ["webhook", "telegram", "email"]).notNull(),
    target: varchar("target", { length: 1000 }).notNull(),
    // escalation=true channels only receive re-notifications of unacknowledged
    // alarms; escalation=false receive the initial breach notification.
    escalation: int("escalation").notNull().default(0),
    enabled: int("enabled").notNull().default(1),
    // Owning org. NULL = global channel (superadmin-managed) — it receives
    // every org's alarms, which is why only a superadmin may create one.
    // Without this column every tenant's alarms went to every tenant's
    // webhook, Telegram chat and mailbox.
    orgId: bigint("org_id", { mode: "number", unsigned: true }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("channels_enabled_idx").on(t.enabled), index("channels_org_idx").on(t.orgId)],
);
export type NotificationChannel = typeof notificationChannels.$inferSelect;

export const alarmNotifications = mysqlTable(
  "alarm_notifications",
  {
    id: serial("id").primaryKey(),
    alarmId: bigint("alarm_id", { mode: "number", unsigned: true }).notNull(),
    channelId: bigint("channel_id", { mode: "number", unsigned: true }).notNull(),
    // "resolved" closes the loop: whoever was told an alarm fired is told when
    // it clears. Without it an operator who got the page never learns the
    // condition ended.
    kind: mysqlEnum("kind", ["initial", "escalation", "resolved"]).notNull().default("initial"),
    status: mysqlEnum("status", ["sent", "failed"]).notNull(),
    error: varchar("error", { length: 500 }),
    // Denormalized from the alarm's meter/gateway so delivery history can be
    // listed per tenant without joining the whole alarm chain.
    orgId: bigint("org_id", { mode: "number", unsigned: true }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("alarm_notif_alarm_idx").on(t.alarmId),
    index("alarm_notif_kind_idx").on(t.alarmId, t.kind, t.channelId),
    index("alarm_notif_org_idx").on(t.orgId),
  ],
);
export type AlarmNotification = typeof alarmNotifications.$inferSelect;

// Maintenance windows: while now ∈ [startsAt, endsAt], new alarms for meters
// bound to siteId (null = all sites/global) are suppressed at evaluation time.
export const maintenanceWindows = mysqlTable(
  "maintenance_windows",
  {
    id: serial("id").primaryKey(),
    siteId: bigint("site_id", { mode: "number", unsigned: true }),
    startsAt: timestamp("starts_at").notNull(),
    endsAt: timestamp("ends_at").notNull(),
    note: varchar("note", { length: 500 }),
    // Owning org. NULL = global suppression window (superadmin-managed).
    orgId: bigint("org_id", { mode: "number", unsigned: true }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("maint_site_idx").on(t.siteId), index("maint_org_idx").on(t.orgId)],
);
export type MaintenanceWindow = typeof maintenanceWindows.$inferSelect;

// ─── v8/D1: automatic EMS strategies ─────────────────────────────────────────
// BESS charge/discharge schedules. Times are minutes from LOCAL midnight in
// the meter's effective site timezone (meters.site_id ?? gateways.site_id →
// sites.timezone, default UTC); day_of_week_mask is a bitmask, bit 0 = Sunday.
// Windows may wrap midnight (start_min > end_min). meter_id references
// meters.id (the BESS); created_by references users.id (null = seed/system).
export const emsSchedules = mysqlTable(
  "ems_schedules",
  {
    id: serial("id").primaryKey(),
    meterId: bigint("meter_id", { mode: "number", unsigned: true }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    dayOfWeekMask: int("day_of_week_mask").notNull(),
    startMin: int("start_min").notNull(),
    endMin: int("end_min").notNull(),
    mode: mysqlEnum("mode", ["charge", "discharge", "idle"]).notNull(),
    // null targetKw = the control register's max (full power); null targetSoc =
    // no SOC guard. SOC guard: discharge stops at/below targetSoc, charge at/above.
    targetKw: double("target_kw"),
    targetSoc: double("target_soc"),
    enabled: boolean("enabled").notNull().default(true),
    createdBy: bigint("created_by", { mode: "number", unsigned: true }),
    // v8/D2: owning org.
    orgId: bigint("org_id", { mode: "number", unsigned: true }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("ems_sched_meter_idx").on(t.meterId), index("ems_sched_org_idx").on(t.orgId)],
);
export type EmsSchedule = typeof emsSchedules.$inferSelect;
export type InsertEmsSchedule = typeof emsSchedules.$inferInsert;

// Automatic peak shaving: watch source_meter_id import power; when it exceeds
// threshold_kw, discharge bess_meter_id at min(import − threshold, max_discharge_kw);
// stop when import falls below threshold_kw − hysteresis_kw.
export const emsPeakShaving = mysqlTable(
  "ems_peak_shaving",
  {
    id: serial("id").primaryKey(),
    siteId: bigint("site_id", { mode: "number", unsigned: true }),
    sourceMeterId: bigint("source_meter_id", { mode: "number", unsigned: true }).notNull(),
    bessMeterId: bigint("bess_meter_id", { mode: "number", unsigned: true }).notNull(),
    thresholdKw: double("threshold_kw").notNull(),
    hysteresisKw: double("hysteresis_kw").notNull().default(0),
    maxDischargeKw: double("max_discharge_kw").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    // v8/D2: owning org.
    orgId: bigint("org_id", { mode: "number", unsigned: true }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("ems_peak_source_idx").on(t.sourceMeterId),
    index("ems_peak_bess_idx").on(t.bessMeterId),
    index("ems_peak_site_idx").on(t.siteId),
    index("ems_peak_org_idx").on(t.orgId),
  ],
);
export type EmsPeakShaving = typeof emsPeakShaving.$inferSelect;
export type InsertEmsPeakShaving = typeof emsPeakShaving.$inferInsert;

// ─── v9: externally-pushed EMS plans (Contract A, VoltTrade optimizer) ───────
// Time-boxed setpoint series pushed via PUT /api/v1/devices/:id/ems-plan.
// setpoints: [{ ts: ISO string, kw: number }] sorted non-descending;
// kw > 0 = discharge, kw < 0 = charge, 0 = idle. valid_from/valid_to are UTC
// naive (project convention — written/read via utcStr raw SQL, never drizzle
// Date serialization). status: active → superseded (a newer overlapping plan
// won) | expired (lazy sweep once valid_to passed).
export const emsPlans = mysqlTable(
  "ems_plans",
  {
    id: serial("id").primaryKey(),
    meterId: bigint("meter_id", { mode: "number", unsigned: true }).notNull(),
    orgId: bigint("org_id", { mode: "number", unsigned: true }).notNull(),
    source: varchar("source", { length: 64 }).notNull().default("unknown"),
    validFrom: timestamp("valid_from").notNull(),
    validTo: timestamp("valid_to").notNull(),
    setpoints: json("setpoints").notNull(), // [{ ts: string, kw: number }]
    // audit wave 6 (migration 0020): optional SoC limits, enforced fail-closed
    // by the EMS controller (blocked → idle 0 kW); also bind peak-shaving
    // discharge on the same BESS while the plan is active.
    minSoc: double("min_soc"),
    maxSoc: double("max_soc"),
    status: varchar("status", { length: 16 }).notNull().default("active"), // active|superseded|expired
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("ems_plans_meter_idx").on(t.meterId, t.status, t.validFrom), index("ems_plans_org_idx").on(t.orgId)],
);
export type EmsPlan = typeof emsPlans.$inferSelect;
export type InsertEmsPlan = typeof emsPlans.$inferInsert;

// ─── v8/D3: scheduled reports ────────────────────────────────────────────────
// A scheduler loop (api/reports/scheduler.ts) generates the energy report for
// the previous completed period (daily/weekly/monthly, in the site's timezone)
// at hourLocal and emails it to recipients. siteId null = all sites (fleet).
export const reportSchedules = mysqlTable(
  "report_schedules",
  {
    id: serial("id").primaryKey(),
    siteId: bigint("site_id", { mode: "number", unsigned: true }),
    name: varchar("name", { length: 255 }).notNull(),
    frequency: mysqlEnum("frequency", ["daily", "weekly", "monthly"]).notNull(),
    format: mysqlEnum("format", ["xlsx", "pdf"]).notNull(),
    recipients: json("recipients").notNull(), // string[] of email addresses
    hourLocal: int("hour_local").notNull(), // 0..23, delivery hour in the site timezone
    enabled: boolean("enabled").notNull().default(true),
    lastRunAt: timestamp("last_run_at"),
    createdBy: bigint("created_by", { mode: "number", unsigned: true }),
    // v8/D2: owning org.
    orgId: bigint("org_id", { mode: "number", unsigned: true }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("report_sched_site_idx").on(t.siteId), index("report_sched_org_idx").on(t.orgId)],
);
export type ReportSchedule = typeof reportSchedules.$inferSelect;
export type InsertReportSchedule = typeof reportSchedules.$inferInsert;

// ─── v8/D5: device management — OTA jobs ─────────────────────────────────────
// Delivery: MQTT gateways get a JSON cmd frame on g2d/<uid>/ota and ack on
// d2g/<uid>/ota (api/ota/manager.ts); TCP/direct gateways get config pushes via
// the C12 whitelisted FC6 path (firmware OTA is not applicable there).
// Status: pending → sent → ack | failed (ack timeout 60 s, ≤ 3 attempts, or
// negative ack / unsupported operation).
export const otaJobs = mysqlTable(
  "ota_jobs",
  {
    id: serial("id").primaryKey(),
    gatewayId: bigint("gateway_id", { mode: "number", unsigned: true }).notNull(),
    type: mysqlEnum("type", ["firmware", "config"]).notNull(),
    payload: json("payload").notNull(), // firmware: {version,url?}; config: {pollIntervalMs?} | {controlKey,value,meterId?} for TCP
    status: mysqlEnum("status", ["pending", "sent", "ack", "failed"]).notNull().default("pending"),
    attempts: int("attempts").notNull().default(0),
    createdBy: bigint("created_by", { mode: "number", unsigned: true }),
    // v8/D2: owning org.
    orgId: bigint("org_id", { mode: "number", unsigned: true }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    sentAt: timestamp("sent_at"),
    ackAt: timestamp("ack_at"),
    error: text("error"),
  },
  (t) => [index("ota_jobs_gateway_idx").on(t.gatewayId), index("ota_jobs_org_idx").on(t.orgId)],
);
export type OtaJob = typeof otaJobs.$inferSelect;
export type InsertOtaJob = typeof otaJobs.$inferInsert;

// ─── §9.15: outbound webhook subscriptions ───────────────────────────────────
// notification_channels already POST alarm JSON at a URL, which is enough for a
// Slack hook and not enough for an integration. Three things were missing, and
// each of them is the reason an integrator refuses to build against a system:
//
//   1. Nothing SIGNED the payload, so a receiver had no way to tell a genuine
//      delivery from anyone who learned the URL.
//   2. A delivery that failed was recorded as failed and dropped. A receiver
//      that was restarting for thirty seconds lost every event in that window,
//      permanently, with no way to ask for them again.
//   3. The only event was "an alarm fired". Control actions — the ones an
//      auditor cares about — were not published at all.
//
// The secret is stored in plaintext rather than hashed, unlike api_keys: it has
// to be REPRODUCED to sign each delivery, not merely compared. It is shown once
// at creation and on rotation, and never returned by a list query.
export const webhookSubscriptions = mysqlTable(
  "webhook_subscriptions",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
    url: varchar("url", { length: 1000 }).notNull(),
    secret: varchar("secret", { length: 128 }).notNull(),
    // Which events this endpoint wants, as a JSON array of event names. An
    // empty array would be a subscription to nothing, so the API refuses it.
    events: json("events").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    // Deliberately NOT auto-disabled after repeated failures. An integration
    // that silently switches itself off is how a customer discovers, weeks
    // later, that their ERP has been missing alarms. The failure count is
    // surfaced instead, and a human decides.
    consecutiveFailures: int("consecutive_failures").notNull().default(0),
    lastSuccessAt: timestamp("last_success_at"),
    lastErrorAt: timestamp("last_error_at"),
    lastError: varchar("last_error", { length: 500 }),
    orgId: bigint("org_id", { mode: "number", unsigned: true }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("webhook_subs_org_idx").on(t.orgId)],
);
export type WebhookSubscription = typeof webhookSubscriptions.$inferSelect;

// One row per (event, subscription). The queue IS the retry: a delivery is
// persisted before anything is sent, so a process that dies mid-send resumes
// instead of losing the event, and next_attempt_at holds the schedule so a
// restart does not stampede every pending delivery at once.
export const webhookDeliveries = mysqlTable(
  "webhook_deliveries",
  {
    id: serial("id").primaryKey(),
    subscriptionId: bigint("subscription_id", { mode: "number", unsigned: true }).notNull(),
    event: varchar("event", { length: 64 }).notNull(),
    // The exact body that is signed and sent. Stored so a retry re-sends the
    // event as it was, not as the database looks now — an alarm that has since
    // been resolved must not be re-delivered as "raised" with a resolved body.
    payload: json("payload").notNull(),
    status: mysqlEnum("status", ["pending", "delivered", "dead"]).notNull().default("pending"),
    attempts: int("attempts").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at").notNull().defaultNow(),
    responseStatus: int("response_status"),
    lastError: varchar("last_error", { length: 500 }),
    deliveredAt: timestamp("delivered_at"),
    orgId: bigint("org_id", { mode: "number", unsigned: true }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("webhook_deliv_due_idx").on(t.status, t.nextAttemptAt),
    index("webhook_deliv_sub_idx").on(t.subscriptionId),
    index("webhook_deliv_org_idx").on(t.orgId),
  ],
);
export type WebhookDelivery = typeof webhookDeliveries.$inferSelect;

// ─── §9.13: REST API rate-limit buckets ──────────────────────────────────────
// One token bucket per (api key, scope). In the DATABASE rather than in
// process memory on purpose: an in-memory limiter multiplies the quota by the
// number of replicas and resets on every deploy, so the published number stops
// being the number. The same reasoning moved login lockout and alarm
// hysteresis out of memory earlier in this branch.
//
// Written on every API request, so it is deliberately one narrow row: a
// primary key lookup and an update, no indexes to maintain beyond the key.
export const apiRateBuckets = mysqlTable(
  "api_rate_buckets",
  {
    keyId: bigint("key_id", { mode: "number", unsigned: true }).notNull(),
    scope: varchar("scope", { length: 32 }).notNull(),
    // Fractional: refill is continuous, so a caller sitting exactly at the
    // limit is spaced out evenly rather than let through in a clump each
    // minute.
    tokens: double("tokens").notNull(),
    updatedAt: timestamp("updated_at", { fsp: 3 }).notNull().defaultNow(),
    // Compare-and-set counter. The natural version would be updated_at, but
    // an equality test on a fractional timestamp depends on the driver
    // round-tripping milliseconds exactly, and a silent mismatch there would
    // make every write lose its race and disable the limiter without anyone
    // noticing. An integer cannot fail that way.
    version: int("version").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.keyId, t.scope] })],
);
export type ApiRateBucket = typeof apiRateBuckets.$inferSelect;


// ─── §9.14: per-org data export ──────────────────────────────────────────────
// A tenant's data has to be able to LEAVE. Until now the only ways out were a
// scheduled energy report (one metric, emailed) and direct database access
// (everyone's data at once). Neither is an answer to "give us our data" —
// which arrives as a contract clause, as a regulator's question, or on the day
// a customer moves to another supplier and is entitled to take their history
// with them.
//
// Built asynchronously because it is not a request-sized job: a year of
// interval data for a site is tens of millions of rows, and a tRPC call that
// tried to return it would time out long before it finished.
export const dataExports = mysqlTable(
  "data_exports",
  {
    id: serial("id").primaryKey(),
    orgId: bigint("org_id", { mode: "number", unsigned: true }).notNull(),
    requestedBy: bigint("requested_by", { mode: "number", unsigned: true }),
    status: mysqlEnum("status", ["pending", "running", "ready", "failed", "expired"]).notNull().default("pending"),
    // Telemetry is optional and bounded by a range: most requests are for
    // configuration and alarms, and defaulting to "every sample ever" would
    // make the common case unusably slow.
    includeTelemetry: boolean("include_telemetry").notNull().default(false),
    rangeFrom: timestamp("range_from"),
    rangeTo: timestamp("range_to"),
    filePath: varchar("file_path", { length: 500 }),
    sizeBytes: bigint("size_bytes", { mode: "number", unsigned: true }),
    // Per-table row counts, so the recipient can check they got everything
    // rather than trusting that a file that opened is a file that is complete.
    rowCounts: json("row_counts"),
    // Random, expiring, and re-issuable. A URL token rather than a session
    // because the file is streamed by a plain HTTP route — see the expiry
    // note in api/orgs/export.ts.
    downloadToken: varchar("download_token", { length: 64 }),
    tokenExpiresAt: timestamp("token_expires_at"),
    error: varchar("error", { length: 500 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    startedAt: timestamp("started_at"),
    completedAt: timestamp("completed_at"),
    // The archive is deleted from disk after this. An export sitting on a
    // server forever is a copy of a tenant's entire history that nobody is
    // watching.
    expiresAt: timestamp("expires_at"),
  },
  (t) => [index("data_exports_org_idx").on(t.orgId), index("data_exports_status_idx").on(t.status)],
);
export type DataExport = typeof dataExports.$inferSelect;

// ─── §9.11: organization membership, invites and switching ───────────────────
// A user belonged to exactly one org (users.org_id) with one global role. Two
// things that come up constantly were therefore impossible: an engineer who
// looks after three customer sites needs access to three tenants, and an
// installer commissioning a new site needs to be brought in without somebody
// typing a password on their behalf and sending it over chat.
//
// Membership is ADDITIVE rather than a rewrite of the scoping model.
// users.org_id and users.role stay exactly what they were — the ACTIVE org and
// the role in it — so every org-scoped query, every guard and every router is
// untouched. Switching org means checking a membership and moving those two
// fields. The invariant is one sentence: users.org_id/users.role mirror the
// membership the user is currently acting under.
export const orgMemberships = mysqlTable(
  "org_memberships",
  {
    id: serial("id").primaryKey(),
    userId: bigint("user_id", { mode: "number", unsigned: true }).notNull(),
    orgId: bigint("org_id", { mode: "number", unsigned: true }).notNull(),
    // The role IN THIS ORG. The same person can be an operator for one tenant
    // and a viewer for another, which is the usual arrangement when a
    // contractor looks after several customers.
    role: mysqlEnum("role", ["admin", "operator", "viewer"]).notNull().default("viewer"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("org_membership_unique").on(t.userId, t.orgId),
    index("org_membership_user_idx").on(t.userId),
    index("org_membership_org_idx").on(t.orgId),
  ],
);
export type OrgMembership = typeof orgMemberships.$inferSelect;

// Invites. The token is stored HASHED, like a session token and an API key: a
// database dump should not hand somebody the ability to create accounts in
// every tenant that has an invite outstanding.
export const orgInvites = mysqlTable(
  "org_invites",
  {
    id: serial("id").primaryKey(),
    orgId: bigint("org_id", { mode: "number", unsigned: true }).notNull(),
    email: varchar("email", { length: 255 }).notNull(),
    role: mysqlEnum("role", ["admin", "operator", "viewer"]).notNull().default("viewer"),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    invitedBy: bigint("invited_by", { mode: "number", unsigned: true }),
    // Invites expire. One that does not is a credential with no owner sitting
    // in an inbox indefinitely.
    expiresAt: timestamp("expires_at").notNull(),
    acceptedAt: timestamp("accepted_at"),
    acceptedUserId: bigint("accepted_user_id", { mode: "number", unsigned: true }),
    revokedAt: timestamp("revoked_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("org_invite_token_unique").on(t.tokenHash),
    index("org_invite_org_idx").on(t.orgId),
    index("org_invite_email_idx").on(t.email),
  ],
);
export type OrgInvite = typeof orgInvites.$inferSelect;

// ─── §9.9: firmware releases and staged rollouts ─────────────────────────────
// Firmware could only be pushed one gateway at a time, from an ad-hoc payload
// carrying whatever URL somebody typed. A fleet update was therefore a script
// looping over every gateway — which is how an installation loses all of them
// at the same moment to a bad image.
//
// A release registry means a rollout points at a KNOWN artifact with a
// checksum, rather than at a URL that was correct in the ticket.
export const firmwareReleases = mysqlTable(
  "firmware_releases",
  {
    id: serial("id").primaryKey(),
    model: varchar("model", { length: 128 }).notNull(),
    version: varchar("version", { length: 64 }).notNull(),
    url: varchar("url", { length: 1000 }).notNull(),
    // sha256 of the image. The gateway is expected to verify it before
    // flashing; recording it here means "which bytes did we ship" has an
    // answer months later, when the question is asked by somebody holding a
    // device that no longer boots.
    sha256: varchar("sha256", { length: 64 }),
    notes: varchar("notes", { length: 1000 }),
    orgId: bigint("org_id", { mode: "number", unsigned: true }),
    createdBy: bigint("created_by", { mode: "number", unsigned: true }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("firmware_model_version_unique").on(t.model, t.version),
    index("firmware_org_idx").on(t.orgId),
  ],
);
export type FirmwareRelease = typeof firmwareReleases.$inferSelect;

// A rollout is the staging policy: canary first, then fixed waves, halting the
// moment the numbers look wrong. There is deliberately no automatic rollback —
// firmware cannot be reliably rolled back over the air, and a gateway that
// boots into an image which no longer reaches the broker is beyond anything
// this system can do. Halting and telling somebody is the honest behaviour.
export const otaRollouts = mysqlTable(
  "ota_rollouts",
  {
    id: serial("id").primaryKey(),
    releaseId: bigint("release_id", { mode: "number", unsigned: true }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    // Its own batch even when it is one device: a rollout that starts with ten
    // is a rollout that can break ten.
    canaryCount: int("canary_count").notNull().default(1),
    batchSize: int("batch_size").notNull().default(10),
    failureThresholdPct: int("failure_threshold_pct").notNull().default(10),
    status: mysqlEnum("status", ["draft", "running", "paused", "halted", "completed"]).notNull().default("draft"),
    haltReason: varchar("halt_reason", { length: 500 }),
    createdBy: bigint("created_by", { mode: "number", unsigned: true }),
    orgId: bigint("org_id", { mode: "number", unsigned: true }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    startedAt: timestamp("started_at"),
    finishedAt: timestamp("finished_at"),
  },
  (t) => [index("ota_rollouts_org_idx").on(t.orgId), index("ota_rollouts_status_idx").on(t.status)],
);
export type OtaRollout = typeof otaRollouts.$inferSelect;

// One row per gateway in the rollout, carrying its wave and the job that was
// created for it. The membership is FROZEN when the rollout is created rather
// than re-evaluated from a filter each sweep: a gateway that comes online
// halfway through must not silently join a wave that has already been judged.
export const otaRolloutTargets = mysqlTable(
  "ota_rollout_targets",
  {
    id: serial("id").primaryKey(),
    rolloutId: bigint("rollout_id", { mode: "number", unsigned: true }).notNull(),
    gatewayId: bigint("gateway_id", { mode: "number", unsigned: true }).notNull(),
    batchIndex: int("batch_index").notNull(),
    status: mysqlEnum("status", ["pending", "sent", "ack", "failed"]).notNull().default("pending"),
    jobId: bigint("job_id", { mode: "number", unsigned: true }),
    error: varchar("error", { length: 500 }),
    updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  },
  (t) => [
    uniqueIndex("ota_rollout_target_unique").on(t.rolloutId, t.gatewayId),
    index("ota_rollout_target_rollout_idx").on(t.rolloutId),
  ],
);
export type OtaRolloutTarget = typeof otaRolloutTargets.$inferSelect;
