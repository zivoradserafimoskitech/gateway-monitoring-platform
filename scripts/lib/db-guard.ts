// Safety guard for destructive maintenance scripts (v5 finding #22).
//
// Every script shares the same .env, so a cleanup meant for a local scratch
// DB could otherwise wipe the shared/prod database with zero friction.
// Destructive scripts must call assertDestructiveOk() first: against a
// non-local DB host they refuse to run unless ALLOW_UNSAFE_PROD=1 is set.
export function assertDestructiveOk(scriptName: string): void {
  const url = process.env.DATABASE_URL ?? "";
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    host = "(unparseable DATABASE_URL)";
  }
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "::1";
  console.log(`[${scriptName}] target DB host: ${host || "(none)"}`);
  if (!isLocal && process.env.ALLOW_UNSAFE_PROD !== "1") {
    console.error(
      `[${scriptName}] REFUSING to run destructive operations against non-local DB '${host}'. ` +
        `Re-run with ALLOW_UNSAFE_PROD=1 if you really intend this.`,
    );
    process.exit(1);
  }
}
