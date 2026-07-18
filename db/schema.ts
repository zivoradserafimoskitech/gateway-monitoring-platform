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
  index,
  uniqueIndex,
} from "drizzle-orm/mysql-core";

// ─── Sites ───────────────────────────────────────────────────────────────────
export const sites = mysqlTable("sites", {
  id: serial("id").primaryKey(),
  name: varchar("name", { length: 255 }).notNull(),
  address: varchar("address", { length: 500 }),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
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
    model: mysqlEnum("model", ["G30", "C30"]).notNull(),
    // json = G30 structured JSON uplink; transparent = C30 raw Modbus passthrough
    transport: mysqlEnum("transport", ["json", "transparent"]).notNull(),
    siteId: bigint("site_id", { mode: "number", unsigned: true }),
    // MQTT uplink topic prefix, e.g. matis/gateway/pVariable or d2g
    topicPrefix: varchar("topic_prefix", { length: 255 }).notNull(),
    status: mysqlEnum("status", ["online", "offline"]).notNull().default("offline"),
    lastSeenAt: timestamp("last_seen_at"),
    rssi: int("rssi"),
    firmware: varchar("firmware", { length: 64 }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("gateways_uid_unique").on(t.uid), index("gateways_site_idx").on(t.siteId)],
);
export type Gateway = typeof gateways.$inferSelect;
export type InsertGateway = typeof gateways.$inferInsert;

// ─── Meters (SEM2250 / SEM3250 / PEM3000) ────────────────────────────────────
export const meters = mysqlTable(
  "meters",
  {
    id: serial("id").primaryKey(),
    gatewayId: bigint("gateway_id", { mode: "number", unsigned: true }).notNull(),
    name: varchar("name", { length: 255 }).notNull(),
    model: mysqlEnum("model", ["SEM2250", "SEM3250", "PEM3000"]).notNull(),
    phases: mysqlEnum("phases", ["single", "three"]).notNull().default("three"),
    modbusAddress: int("modbus_address").notNull(),
    channel: int("channel").notNull().default(1),
    status: mysqlEnum("status", ["online", "offline"]).notNull().default("offline"),
    lastSeenAt: timestamp("last_seen_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [
    index("meters_gateway_idx").on(t.gatewayId),
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
    raw: json("raw"),
  },
  (t) => [index("telemetry_meter_ts_idx").on(t.meterId, t.ts)],
);
export type Telemetry = typeof telemetry.$inferSelect;
export type InsertTelemetry = typeof telemetry.$inferInsert;

// ─── Alarm rules ─────────────────────────────────────────────────────────────
export const alarmRules = mysqlTable("alarm_rules", {
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
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
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
  },
  (t) => [index("alarms_status_idx").on(t.status), index("alarms_meter_idx").on(t.meterId)],
);
export type Alarm = typeof alarms.$inferSelect;
export type InsertAlarm = typeof alarms.$inferInsert;

// ─── Device profiles: editable Modbus register maps per meter model ─────────
// NOTE: the vendor Modbus protocol document was not supplied, so register maps
// are stored as editable configuration and can be corrected per project.
export const deviceProfiles = mysqlTable("device_profiles", {
  id: serial("id").primaryKey(),
  model: varchar("model", { length: 64 }).notNull(),
  label: varchar("label", { length: 255 }).notNull(),
  // Array of { key, label, address, functionCode, type, scale, unit }
  registerMap: json("register_map").notNull(),
  updatedAt: timestamp("updated_at").notNull().defaultNow().onUpdateNow(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});
export type DeviceProfile = typeof deviceProfiles.$inferSelect;
export type InsertDeviceProfile = typeof deviceProfiles.$inferInsert;

// ─── Downlink command log ────────────────────────────────────────────────────
export const commands = mysqlTable(
  "commands",
  {
    id: serial("id").primaryKey(),
    gatewayId: bigint("gateway_id", { mode: "number", unsigned: true }).notNull(),
    meterId: bigint("meter_id", { mode: "number", unsigned: true }),
    kind: varchar("kind", { length: 64 }).notNull(), // readNow | custom
    payloadHex: varchar("payload_hex", { length: 2048 }).notNull(),
    topic: varchar("topic", { length: 255 }).notNull(),
    status: mysqlEnum("status", ["sent", "failed"]).notNull().default("sent"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => [index("commands_gateway_idx").on(t.gatewayId)],
);
export type Command = typeof commands.$inferSelect;
export type InsertCommand = typeof commands.$inferInsert;
