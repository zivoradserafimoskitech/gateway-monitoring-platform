import { sql } from "drizzle-orm";
import {
  mysqlTable,
  mysqlEnum,
  serial,
  varchar,
  timestamp,
  bigint,
  int,
  double,
  boolean,
  json,
  text,
  index,
  uniqueIndex,
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
    operator: mysqlEnum("operator", ["gt", "lt"]).notNull(),
    threshold: double("threshold").notNull(),
    severity: mysqlEnum("severity", ["info", "warning", "critical"]).notNull().default("warning"),
    // null meterId => applies to all meters
    meterId: bigint("meter_id", { mode: "number", unsigned: true }),
    enabled: boolean("enabled").notNull().default(true),
    // v8/D2: owning org.
    orgId: bigint("org_id", { mode: "number", unsigned: true }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("alarm_rules_org_idx").on(t.orgId)],
);
export type AlarmRule = typeof alarmRules.$inferSelect;
export type InsertAlarmRule = typeof alarmRules.$inferInsert;

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
  },
  (t) => [index("commands_gateway_idx").on(t.gatewayId), index("commands_meter_idx").on(t.meterId)],
);
export type Command = typeof commands.$inferSelect;
export type InsertCommand = typeof commands.$inferInsert;

// ─── Multi-tenancy (v8 D2) ───────────────────────────────────────────────────
// Every tenant-owned row carries org_id (backfilled to "Default Org"). The
// superadmin (users.is_superadmin) sees all orgs; everyone else only their own.
export const orgs = mysqlTable(
  "orgs",
  {
    id: serial("id").primaryKey(),
    name: varchar("name", { length: 255 }).notNull(),
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
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("audit_created_idx").on(t.createdAt)],
);
export type AuditLogRow = typeof auditLog.$inferSelect;

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
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("channels_enabled_idx").on(t.enabled)],
);
export type NotificationChannel = typeof notificationChannels.$inferSelect;

export const alarmNotifications = mysqlTable(
  "alarm_notifications",
  {
    id: serial("id").primaryKey(),
    alarmId: bigint("alarm_id", { mode: "number", unsigned: true }).notNull(),
    channelId: bigint("channel_id", { mode: "number", unsigned: true }).notNull(),
    kind: mysqlEnum("kind", ["initial", "escalation"]).notNull().default("initial"),
    status: mysqlEnum("status", ["sent", "failed"]).notNull(),
    error: varchar("error", { length: 500 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("alarm_notif_alarm_idx").on(t.alarmId), index("alarm_notif_kind_idx").on(t.alarmId, t.kind, t.channelId)],
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
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("maint_site_idx").on(t.siteId)],
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
