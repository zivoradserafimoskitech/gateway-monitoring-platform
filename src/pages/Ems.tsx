// v10/Модул A: EMS Control Center — fleet-level page. Until now EMS lived only
// inside MeterDetail; this page adds the fleet "recent automatic commands" feed
// (all org devices, no meterId filter) on top of the existing per-device
// EmsPanel (schedules + peak shaving) and EmsPlanCard (optimizer plans).
import { useState } from "react";
import { Link } from "react-router";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { fmt, fmtTime } from "@/components/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ExternalLink } from "lucide-react";
import { EmsPanel } from "@/components/EmsPanel";
import { EmsPlanCard } from "@/components/EmsPlanCard";

/** Origin attribution from the commands.result prefix (see api/ems/controller.ts tagLastCommand). */
function originBadge(result: string | null, t: ReturnType<typeof useI18n>["t"]): { label: string; cls: string } {
  const r = result ?? "";
  if (r.startsWith("plan:")) return { label: t.emsPage.originPlan, cls: "bg-blue-100 text-blue-700" };
  if (r.startsWith("peak:")) return { label: t.emsPage.originPeak, cls: "bg-amber-100 text-amber-700" };
  if (r.startsWith("schedule:")) return { label: t.emsPage.originSchedule, cls: "bg-emerald-100 text-emerald-700" };
  return { label: t.emsPage.originOther, cls: "bg-slate-100 text-slate-600" };
}

export default function Ems() {
  const { t } = useI18n();
  const meters = trpc.meters.list.useQuery();
  // Fleet feed: no meterId → all org devices (router scopes via org meter ids).
  const autoCommands = trpc.ems.autoCommands.useQuery({ limit: 20 }, { refetchInterval: 10000 });

  const bessMeters = (meters.data ?? []).filter((m) => m.deviceType === "bess");
  const [selected, setSelected] = useState<number | null>(null);
  const meterId = selected ?? bessMeters[0]?.id ?? null;
  const meterName = (id: number | null) => (id !== null && (meters.data ?? []).find((m) => m.id === id)?.name) || `#${id ?? "?"}`;

  const rows = autoCommands.data ?? [];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t.emsPage.title}</h1>
        <p className="text-sm text-slate-500">{t.emsPage.subtitle}</p>
      </div>

      {/* ── Fleet commands (all org devices, live) ── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            {t.emsPage.fleetCommands}
            <span className="flex items-center gap-1.5 rounded bg-emerald-50 px-1.5 py-0.5 text-xs font-medium text-emerald-700">
              <span className="relative flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
              </span>
              {t.emsPage.live}
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {rows.length === 0 ? (
            <p className="text-sm text-slate-400">{t.common.noData}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.emsPlan.time}</TableHead>
                  <TableHead>{t.emsPage.meter}</TableHead>
                  <TableHead>{t.emsPage.colKey}</TableHead>
                  <TableHead className="text-right">{t.emsPage.colKw}</TableHead>
                  <TableHead>{t.emsPage.colResult}</TableHead>
                  <TableHead>{t.emsPage.colOrigin}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((c) => {
                  const origin = originBadge(c.result, t);
                  return (
                    <TableRow key={c.id}>
                      <TableCell className="whitespace-nowrap text-xs text-slate-500">{fmtTime(c.createdAt)}</TableCell>
                      <TableCell className="text-sm font-medium">{meterName(c.meterId)}</TableCell>
                      <TableCell className="font-mono text-xs">{c.controlKey}</TableCell>
                      <TableCell className="text-right font-mono text-xs">{fmt(c.controlValue, 1)}</TableCell>
                      <TableCell className="max-w-64 truncate text-xs text-slate-500" title={c.result ?? undefined}>
                        {c.result ?? "—"}
                      </TableCell>
                      <TableCell>
                        <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${origin.cls}`}>{origin.label}</span>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* ── Per-device section ── */}
      {bessMeters.length === 0 ? (
        <Card>
          <CardContent className="py-6">
            <p className="text-sm text-slate-500">{t.emsPage.noBess}</p>
          </CardContent>
        </Card>
      ) : (
        meterId !== null && (
          <>
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-sm font-medium text-slate-600">{t.emsPage.selectMeter}</span>
              <Select value={String(meterId)} onValueChange={(v) => setSelected(Number(v))}>
                <SelectTrigger className="w-64">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {bessMeters.map((m) => (
                    <SelectItem key={m.id} value={String(m.id)}>
                      {m.name} (#{m.id})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="ghost" size="sm" asChild>
                <Link to={`/meters/${meterId}`}>
                  <ExternalLink className="h-3.5 w-3.5" /> {t.emsPage.openMeter}
                </Link>
              </Button>
            </div>
            <EmsPanel key={meterId} meterId={meterId} deviceType="bess" />
            <EmsPlanCard meterId={meterId} />
          </>
        )
      )}
    </div>
  );
}
