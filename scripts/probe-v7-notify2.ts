// v7/C2 probe part 2: escalation sweep + maintenance suppression + cleanup.
process.env.ALARM_ESCALATE_MIN = "0"; // every unacked active alarm is stale
import "dotenv/config";
import http from "node:http";
import { getDb } from "../api/queries/connection";
import { alarms, alarmRules, meters, maintenanceWindows, notificationChannels, alarmNotifications } from "../db/schema";
import { eq, inArray } from "drizzle-orm";
import { escalationSweep, isInMaintenance, invalidateMaintenanceCache } from "../api/alarms/notify";

const received: { path: string; body: any }[] = [];
const srv = http.createServer((req, res) => {
  let b = "";
  req.on("data", (c) => (b += c));
  req.on("end", () => {
    received.push({ path: req.url ?? "", body: b ? JSON.parse(b) : {} });
    res.writeHead(200); res.end();
  });
});

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  await new Promise<void>((r) => srv.listen(9901, () => r()));
  const db = getDb();
  let fails = 0;
  const probe = (name: string, ok: boolean, detail: unknown) => {
    console.log(ok ? "PASS" : "FAIL", name, "->", JSON.stringify(detail).slice(0, 160));
    if (!ok) fails++;
  };

  // escalation channel pointing at our sink
  const esc = await db.insert(notificationChannels)
    .values({ name: "probe-esc2", type: "webhook", target: "http://127.0.0.1:9901/esc", escalation: 1, enabled: 1 })
    .$returningId();

  // any unacked active alarm (from part 1: id 2845007) — age it past the
  // default 15-min escalation delay (module constant loads before env tweak)
  const active = await db.select().from(alarms).where(inArray(alarms.status, ["active"]));
  probe("active unacked alarm present", active.length > 0, active.map((a) => a.id));
  if (active[0]) {
    await db.update(alarms).set({ triggeredAt: new Date(Date.now() - 3_600_000) }).where(eq(alarms.id, active[0].id));
  }

  const sweep = await escalationSweep();
  await sleep(500);
  const escHits = received.filter((r) => r.path === "/esc" && r.body.kind === "escalation");
  probe("escalation sweep dispatched", sweep.escalated > 0 && escHits.length > 0, { sweep, hits: escHits.length });

  // dedup: second sweep must NOT re-deliver
  received.length = 0;
  const sweep2 = await escalationSweep();
  probe("escalation dedup (no re-delivery)", sweep2.escalated === 0 && received.length === 0, { sweep2 });

  // maintenance: global window suppresses new alarm activations
  const m = await db.select().from(meters).where(eq(meters.id, 1)).limit(1);
  await db.insert(maintenanceWindows).values({
    siteId: null,
    startsAt: new Date(Date.now() - 60_000),
    endsAt: new Date(Date.now() + 600_000),
    note: "probe",
  });
  invalidateMaintenanceCache();
  const suppressed = await isInMaintenance(m[0]);
  probe("global maintenance window suppresses", suppressed === true, suppressed);
  await db.delete(maintenanceWindows).where(eq(maintenanceWindows.note, "probe"));
  invalidateMaintenanceCache();
  const unsuppressed = await isInMaintenance(m[0]);
  probe("suppression lifted after window removal", unsuppressed === false, unsuppressed);

  // cleanup part-1 + part-2 probe artifacts
  await db.delete(alarms).where(inArray(alarms.ruleId, [150004, 150005]));
  await db.delete(alarmRules).where(inArray(alarmRules.id, [150004, 150005]));
  const chans = await db.select().from(notificationChannels);
  const probeChans = chans.filter((c) => c.name.startsWith("probe-")).map((c) => c.id);
  if (probeChans.length) {
    await db.delete(alarmNotifications).where(inArray(alarmNotifications.channelId, probeChans));
    await db.delete(notificationChannels).where(inArray(notificationChannels.id, probeChans));
  }
  console.log("cleaned:", { channels: probeChans, escChannel: esc[0].id });
  srv.close();
  console.log(fails === 0 ? "=== ALL PASS" : `=== ${fails} FAILURES`);
  process.exit(fails === 0 ? 0 : 1);
}
main().catch((e) => { console.error(e); process.exit(1); });
