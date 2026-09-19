// §9.14: per-org data export.
//
// A tenant's data has to be able to leave. Before this the only ways out were
// a scheduled energy report (one metric, emailed) and direct database access
// (everybody's data at once). Neither answers "give us our data", which
// arrives as a contract clause, as a regulator's question, or on the day a
// customer moves to another supplier and is entitled to take their history.
//
// Asynchronous because it is not a request-sized job: a year of interval data
// for one site is tens of millions of rows, and a tRPC call trying to return
// it would time out long before it finished.
//
// NDJSON rather than one JSON document: the reader can stream it, and a
// truncated file is detectably truncated instead of being an unparseable blob.
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { and, asc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { getDb } from "../queries/connection";
import {
  alarms,
  commands,
  dataExports,
  gateways,
  meters,
  orgs,
  sites,
  users,
} from "@db/schema";
import { withLease } from "../lib/leader";

const SWEEP_MS = 15_000;
/** Rows per query while streaming a table out. Bounded so one export cannot
 *  pull an arbitrary number of rows into memory at once. */
const PAGE = 5_000;
/** How long a finished archive stays on disk. */
export const EXPORT_TTL_HOURS = parseInt(process.env.EXPORT_TTL_HOURS || "72", 10);
/**
 * How long a download link stays valid.
 *
 * Short on purpose: the token travels in a URL, and URLs end up in proxy logs,
 * browser history and chat messages. Fifteen minutes is enough to start a
 * download and short enough that a leaked link is usually already dead — and
 * the link is re-issuable by anyone who could have asked for the export in the
 * first place, so a expired one costs a click rather than a new export.
 */
export const DOWNLOAD_TTL_MIN = parseInt(process.env.EXPORT_DOWNLOAD_TTL_MIN || "15", 10);

export function exportOutDir(): string {
  const dir = process.env.EXPORT_OUT_DIR || path.join(process.cwd(), "data", "exports");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function newDownloadToken(): string {
  return randomBytes(32).toString("hex");
}

/** One NDJSON section: a header line naming the table, then its rows. */
function writeSection(stream: fs.WriteStream, table: string, rows: unknown[]): void {
  stream.write(`${JSON.stringify({ _table: table, _rows: rows.length })}\n`);
  for (const r of rows) stream.write(`${JSON.stringify(r)}\n`);
}

/**
 * Build one export. Returns the row counts so the recipient can verify the
 * file is complete rather than trusting that a file which opened is a file
 * that is whole.
 */
export async function buildExport(exportId: number): Promise<void> {
  const db = getDb();
  const rows = await db.select().from(dataExports).where(eq(dataExports.id, exportId)).limit(1);
  const job = rows[0];
  if (!job) return;

  await db
    .update(dataExports)
    .set({ status: "running", startedAt: new Date() })
    .where(eq(dataExports.id, exportId));

  const dir = exportOutDir();
  const filename = `org-${job.orgId}-export-${exportId}.ndjson`;
  const filePath = path.join(dir, filename);
  const counts: Record<string, number> = {};

  try {
    const stream = fs.createWriteStream(filePath, { encoding: "utf8" });
    const done = new Promise<void>((resolve, reject) => {
      stream.on("error", reject);
      stream.on("finish", () => resolve());
    });

    const org = await db.select().from(orgs).where(eq(orgs.id, job.orgId)).limit(1);
    stream.write(
      `${JSON.stringify({
        _export: exportId,
        _org: job.orgId,
        _orgName: org[0]?.name ?? null,
        _generatedAt: new Date().toISOString(),
        _includesTelemetry: job.includeTelemetry,
        _range: job.rangeFrom && job.rangeTo
          ? { from: job.rangeFrom.toISOString(), to: job.rangeTo.toISOString() }
          : null,
      })}\n`,
    );

    // Configuration first: it is small, and it is what makes the telemetry
    // readable by whoever receives the file.
    const siteRows = await db.select().from(sites).where(eq(sites.orgId, job.orgId));
    writeSection(stream, "sites", siteRows);
    counts.sites = siteRows.length;

    const gatewayRows = await db.select().from(gateways).where(eq(gateways.orgId, job.orgId));
    writeSection(stream, "gateways", gatewayRows);
    counts.gateways = gatewayRows.length;

    const meterRows = await db.select().from(meters).where(eq(meters.orgId, job.orgId));
    writeSection(stream, "devices", meterRows);
    counts.devices = meterRows.length;

    // Users without their credentials. An export is a copy of a tenant's data,
    // not a copy of their password hashes and MFA secrets — those protect the
    // accounts and have no business leaving in a file somebody will email.
    const userRows = await db
      .select({
        id: users.id,
        email: users.email,
        name: users.name,
        role: users.role,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.orgId, job.orgId));
    writeSection(stream, "users", userRows);
    counts.users = userRows.length;

    const meterIds = meterRows.map((m) => m.id);
    const alarmRows = meterIds.length
      ? await db.select().from(alarms).where(inArray(alarms.meterId, meterIds))
      : [];
    writeSection(stream, "alarms", alarmRows);
    counts.alarms = alarmRows.length;

    // The control audit trail. This is the part a dispute is actually about:
    // who wrote what to which device, and how it ended.
    const commandRows = meterIds.length
      ? await db.select().from(commands).where(inArray(commands.meterId, meterIds))
      : [];
    writeSection(stream, "commands", commandRows);
    counts.commands = commandRows.length;

    if (job.includeTelemetry && meterIds.length > 0 && job.rangeFrom && job.rangeTo) {
      // Paged by (ts, id) rather than OFFSET: the table is being written to
      // while this runs, and an offset page skips or repeats rows whenever
      // something is inserted between queries.
      let total = 0;
      stream.write(`${JSON.stringify({ _table: "telemetry", _rows: "streamed" })}\n`);
      let afterTs = job.rangeFrom;
      let afterId = 0;
      for (;;) {
        const page: Array<Record<string, unknown>> = await db.execute(
          // Every column: an export that silently dropped voltage and current
          // would be a summary, and the point is that the tenant gets their
          // data rather than our idea of the interesting parts of it.
          sql`select * from telemetry
              where meter_id in (${sql.join(meterIds.map((id) => sql`${id}`), sql`, `)})
                and ts >= ${afterTs} and ts <= ${job.rangeTo}
                and (ts > ${afterTs} or id > ${afterId})
              order by ts asc, id asc
              limit ${PAGE}`,
        ).then((r) => (r as unknown as [Array<Record<string, unknown>>])[0]);
        if (page.length === 0) break;
        for (const row of page) stream.write(`${JSON.stringify(row)}\n`);
        total += page.length;
        const last = page[page.length - 1];
        afterTs = new Date(String(last.ts));
        afterId = Number(last.id);
        if (page.length < PAGE) break;
      }
      stream.write(`${JSON.stringify({ _table: "telemetry", _rows: total })}\n`);
      counts.telemetry = total;
    }

    stream.end();
    await done;

    const { size } = fs.statSync(filePath);
    await db
      .update(dataExports)
      .set({
        status: "ready",
        filePath,
        sizeBytes: size,
        rowCounts: counts,
        completedAt: new Date(),
        expiresAt: new Date(Date.now() + EXPORT_TTL_HOURS * 3_600_000),
      })
      .where(eq(dataExports.id, exportId));
  } catch (e) {
    // A half-written archive is worse than none: it looks like data and is
    // not, so it goes rather than sitting there waiting to be trusted.
    try {
      fs.rmSync(filePath, { force: true });
    } catch {
      /* the failure below is the one worth reporting */
    }
    await db
      .update(dataExports)
      .set({
        status: "failed",
        error: (e instanceof Error ? e.message : String(e)).slice(0, 500),
        completedAt: new Date(),
      })
      .where(eq(dataExports.id, exportId));
  }
}

/** Build pending exports, and clean up ones whose archive has aged out. */
export async function exportSweep(now: Date = new Date()): Promise<{ built: number; expired: number }> {
  const db = getDb();
  const pending = await db
    .select({ id: dataExports.id })
    .from(dataExports)
    .where(eq(dataExports.status, "pending"))
    .orderBy(asc(dataExports.id))
    .limit(3);
  for (const p of pending) await buildExport(p.id);

  const stale = await db
    .select({ id: dataExports.id, filePath: dataExports.filePath })
    .from(dataExports)
    .where(and(eq(dataExports.status, "ready"), lte(dataExports.expiresAt, now)))
    .limit(50);
  for (const s of stale) {
    if (s.filePath) {
      try {
        fs.rmSync(s.filePath, { force: true });
      } catch (e) {
        console.warn("[export] could not remove expired archive:", e instanceof Error ? e.message : e);
      }
    }
    await db
      .update(dataExports)
      .set({ status: "expired", filePath: null, downloadToken: null, tokenExpiresAt: null })
      .where(eq(dataExports.id, s.id));
  }
  return { built: pending.length, expired: stale.length };
}

/** Resolve a download token to a readable archive, or null. */
export async function exportForToken(token: string, now: Date = new Date()) {
  if (!token || token.length !== 64) return null;
  const rows = await getDb()
    .select()
    .from(dataExports)
    .where(and(eq(dataExports.downloadToken, token), eq(dataExports.status, "ready"), gte(dataExports.tokenExpiresAt, now)))
    .limit(1);
  const row = rows[0];
  if (!row?.filePath || !fs.existsSync(row.filePath)) return null;
  return row;
}

let timer: NodeJS.Timeout | null = null;
export function startExportLoop(): void {
  if (timer) return;
  timer = setInterval(() => {
    // Leased: two replicas building the same export would race on one file
    // path and the loser would publish a truncated archive.
    withLease("data-export", () => exportSweep()).catch((e) =>
      console.warn("[export] sweep failed:", e instanceof Error ? e.message : e),
    );
  }, SWEEP_MS);
  timer.unref?.();
  console.log("[export] builder started");
}
