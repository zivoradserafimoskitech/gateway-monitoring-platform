// v3 migration: meters → multi-device (inverters/BESS/weather).
// Idempotent: every ALTER is guarded by information_schema checks.
// Run: npx tsx scripts/migrate-v3.ts
import mysql from "mysql2/promise";
import "dotenv/config";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL not set");

const conn = await mysql.createConnection({ uri: url, multipleStatements: false });
const dbName = new URL(url).pathname.replace(/^\//, "").split("?")[0];

async function columnExists(table: string, column: string): Promise<boolean> {
  const [rows] = await conn.query(
    `select count(*) as n from information_schema.columns
     where table_schema = ? and table_name = ? and column_name = ?`,
    [dbName, table, column],
  );
  return (rows as Array<{ n: number }>)[0].n > 0;
}

async function columnType(table: string, column: string): Promise<string> {
  const [rows] = await conn.query(
    `select data_type as t from information_schema.columns
     where table_schema = ? and table_name = ? and column_name = ?`,
    [dbName, table, column],
  );
  return (rows as Array<{ t: string }>)[0]?.t ?? "";
}

async function indexExists(table: string, index: string): Promise<boolean> {
  const [rows] = await conn.query(
    `select count(*) as n from information_schema.statistics
     where table_schema = ? and table_name = ? and index_name = ?`,
    [dbName, table, index],
  );
  return (rows as Array<{ n: number }>)[0].n > 0;
}

const steps: Array<[string, () => Promise<void>]> = [];

// meters.model: enum → varchar(128)
if ((await columnType("meters", "model")) === "enum") {
  steps.push(["meters.model enum→varchar(128)", async () => {
    await conn.query(`alter table meters modify model varchar(128) not null`);
  }]);
}
// gateways.model / transport: enums → varchar (adds "TCP"/"tcp" for the direct
// Modbus TCP system gateway used by poller-managed devices)
if ((await columnType("gateways", "model")) === "enum") {
  steps.push(["gateways.model enum→varchar(16)", async () => {
    await conn.query(`alter table gateways modify model varchar(16) not null`);
  }]);
}
if ((await columnType("gateways", "transport")) === "enum") {
  steps.push(["gateways.transport enum→varchar(16)", async () => {
    await conn.query(`alter table gateways modify transport varchar(16) not null`);
  }]);
}
for (const [col, ddl] of [
  ["device_type", `alter table meters add column device_type varchar(32) not null default 'meter' after model`],
  ["brand", `alter table meters add column brand varchar(64) null after device_type`],
  ["host", `alter table meters add column host varchar(255) null`],
  ["port", `alter table meters add column port int null`],
  ["unit_id", `alter table meters add column unit_id int null`],
  ["poll_interval_sec", `alter table meters add column poll_interval_sec int not null default 60`],
] as const) {
  if (!(await columnExists("meters", col))) {
    steps.push([`meters add ${col}`, async () => { await conn.query(ddl); }]);
  }
}

// telemetry.values_json
if (!(await columnExists("telemetry", "values_json"))) {
  steps.push(["telemetry add values_json", async () => {
    await conn.query(`alter table telemetry add column values_json json null`);
  }]);
}

// device_profiles extensions
for (const [col, ddl] of [
  ["brand", `alter table device_profiles add column brand varchar(64) null after label`],
  ["device_type", `alter table device_profiles add column device_type varchar(32) not null default 'meter' after brand`],
  ["protocol", `alter table device_profiles add column protocol varchar(16) not null default 'rtu' after device_type`],
  ["source", `alter table device_profiles add column source varchar(32) not null default 'template' after protocol`],
  ["source_url", `alter table device_profiles add column source_url varchar(500) null after source`],
  ["notes", `alter table device_profiles add column notes text null after source_url`],
  ["fault_codes", `alter table device_profiles add column fault_codes json null`],
] as const) {
  if (!(await columnExists("device_profiles", col))) {
    steps.push([`device_profiles add ${col}`, async () => { await conn.query(ddl); }]);
  }
}
if (!(await indexExists("device_profiles", "device_profiles_model_unique"))) {
  steps.push(["device_profiles unique(model)", async () => {
    await conn.query(`alter table device_profiles add unique index device_profiles_model_unique (model)`);
  }]);
}
// widen device_profiles.model to 128 if needed
const [lenRows] = await conn.query(
  `select character_maximum_length as l from information_schema.columns
   where table_schema = ? and table_name = 'device_profiles' and column_name = 'model'`,
  [dbName],
);
if (Number((lenRows as Array<{ l: number }>)[0]?.l ?? 0) < 128) {
  steps.push(["device_profiles.model → varchar(128)", async () => {
    await conn.query(`alter table device_profiles modify model varchar(128) not null`);
  }]);
}

if (steps.length === 0) {
  console.log("v3 migration: already up to date, nothing to do.");
} else {
  for (const [label, fn] of steps) {
    process.stdout.write(`  ${label} ... `);
    await fn();
    console.log("ok");
  }
  console.log(`v3 migration: ${steps.length} change(s) applied.`);
}
await conn.end();
