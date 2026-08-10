import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowLeft } from "lucide-react";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SingleLineDiagram, type DiagramDevice } from "@/components/diagram/SingleLineDiagram";

// D4: /sites/:id/diagram — live single-line diagram of one site.
// Reuses the existing routers: sites.list, meters.list, gateways.list,
// alarms.list and meters.latest (polled every 10 s).
const POLL_MS = 10_000;

type LatestValues = Record<string, number>;

export default function SiteDiagram() {
  const { id } = useParams<{ id: string }>();
  const siteId = Number(id);
  const { t } = useI18n();
  const utils = trpc.useUtils();

  const sites = trpc.sites.list.useQuery();
  const meters = trpc.meters.list.useQuery(undefined, { refetchInterval: POLL_MS });
  const gateways = trpc.gateways.list.useQuery(undefined, { refetchInterval: POLL_MS });
  const activeAlarms = trpc.alarms.list.useQuery(
    { status: "active", limit: 200 },
    { refetchInterval: POLL_MS },
  );

  const site = (sites.data ?? []).find((s) => s.id === siteId);

  // Effective site binding: meter's own siteId, else its gateway's siteId
  // (mirrors the coalesce() logic in the meters.list router).
  const devices = useMemo(() => {
    const siteGwIds = new Set(
      (gateways.data ?? []).filter((g) => g.siteId === siteId).map((g) => g.id),
    );
    return (meters.data ?? []).filter((m) => m.siteId === siteId || siteGwIds.has(m.gatewayId));
  }, [meters.data, gateways.data, siteId]);

  const alarmedIds = useMemo(() => {
    const set = new Set<number>();
    for (const a of activeAlarms.data ?? []) {
      if (a.meterId !== null) set.add(a.meterId);
    }
    return set;
  }, [activeAlarms.data]);

  // Poll latest telemetry for every site device. Done through the tRPC utils
  // client (not per-device hooks) so the hook count stays constant no matter
  // how many devices the site has.
  const [latestById, setLatestById] = useState<Record<number, LatestValues>>({});
  const idsKey = devices.map((d) => d.id).join(",");
  useEffect(() => {
    let cancelled = false;
    const ids = idsKey === "" ? [] : idsKey.split(",").map(Number);
    async function poll() {
      const entries = await Promise.all(
        ids.map(async (meterId) => {
          try {
            const row = await utils.meters.latest.fetch({ meterId });
            return [meterId, (row?.values ?? {}) as LatestValues] as const;
          } catch {
            return [meterId, {}] as const;
          }
        }),
      );
      if (!cancelled) setLatestById(Object.fromEntries(entries));
    }
    void poll();
    const iv = setInterval(() => void poll(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(iv);
    };
  }, [idsKey, utils]);

  const toNode = (m: (typeof devices)[number]): DiagramDevice => ({
    id: m.id,
    name: m.name,
    model: m.model,
    deviceType: (m.deviceType ?? "meter") as string,
    status: m.status,
    alarm: alarmedIds.has(m.id),
    values: latestById[m.id] ?? {},
  });

  // The first plain meter on the site acts as the main meter at the PCC;
  // inverters and BESS devices become busbar branches.
  const mainMeterRow = devices.find((d) => (d.deviceType ?? "meter") === "meter");
  const branchRows = devices.filter((d) => d.deviceType === "inverter" || d.deviceType === "bess");

  const loading = meters.isLoading || sites.isLoading;

  return (
    <div className="space-y-6">
      <div>
        <Link
          to="/gateways"
          className="mb-1 inline-flex items-center gap-1 text-xs text-slate-500 hover:underline"
        >
          <ArrowLeft className="h-3 w-3" /> {t.gateways.title}
        </Link>
        <h1 className="text-2xl font-bold tracking-tight">
          {site ? `${site.name} — ${t.diagram.title}` : t.diagram.title}
        </h1>
        <p className="text-sm text-slate-500">{t.diagram.subtitle}</p>
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">{t.diagram.title}</CardTitle>
          <div className="flex items-center gap-4 text-xs text-slate-500">
            <span className="font-medium text-slate-600">{t.diagram.legend}:</span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-emerald-600" /> {t.common.online}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-gray-400" /> {t.common.offline}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span className="h-2.5 w-2.5 rounded-full bg-red-600" /> {t.diagram.alarmActive}
            </span>
          </div>
        </CardHeader>
        <CardContent>
          {loading ? (
            <p className="py-10 text-center text-sm text-slate-500">{t.common.loading}</p>
          ) : !site ? (
            <p className="py-10 text-center text-sm text-slate-500">{t.diagram.siteNotFound}</p>
          ) : devices.length === 0 ? (
            <p className="py-10 text-center text-sm text-slate-500">{t.diagram.noDevices}</p>
          ) : (
            <SingleLineDiagram
              mainMeter={mainMeterRow ? toNode(mainMeterRow) : null}
              branches={branchRows.map(toNode)}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
