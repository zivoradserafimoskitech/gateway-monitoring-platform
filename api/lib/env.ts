import "dotenv/config";

function required(name: string): string {
  const value = process.env[name];
  if (!value && process.env.NODE_ENV === "production") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value ?? "";
}

function intWithDefault(name: string, def: number): number {
  const v = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(v) && v > 0 ? v : def;
}

export const env = {
  appId: required("APP_ID"),
  appSecret: required("APP_SECRET"),
  isProduction: process.env.NODE_ENV === "production",
  databaseUrl: required("DATABASE_URL"),
  // audit wave 6: max telemetry age accepted for EMS CONTROL decisions
  // (TelemetryStore.freshForControl default). Read ONCE here at boot — never
  // per call. Dashboards/reads keep using latest() with no age bound.
  controlTelemetryMaxAgeMs: intWithDefault("CONTROL_TELEMETRY_MAX_AGE_MS", 120_000),
};
