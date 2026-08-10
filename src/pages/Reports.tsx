import { useMemo, useState } from "react";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { fmt } from "@/components/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Download, Play } from "lucide-react";
import { csvCell } from "@/lib/csv";

function toInputDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export default function Reports() {
  const { t } = useI18n();
  const meters = trpc.meters.list.useQuery();
  const sites = trpc.sites.list.useQuery();

  const [scope, setScope] = useState<"meter" | "site">("meter");
  const [meterId, setMeterId] = useState<string>("");
  const [siteId, setSiteId] = useState<string>("");
  const [from, setFrom] = useState(toInputDate(new Date(Date.now() - 6 * 86400_000)));
  const [to, setTo] = useState(toInputDate(new Date()));
  const [run, setRun] = useState(0);

  const ready = scope === "meter" ? !!meterId : !!siteId;
  const report = trpc.reports.energy.useQuery(
    {
      scope,
      meterId: scope === "meter" ? Number(meterId) : undefined,
      siteId: scope === "site" ? Number(siteId) : undefined,
      from: new Date(from + "T00:00:00"),
      to: new Date(to + "T23:59:59"),
    },
    { enabled: run > 0 && ready },
  );

  const csv = useMemo(() => {
    const r = report.data;
    if (!r) return "";
    const lines = ["Meter,Day,Import kWh,Export kWh,Max demand kW,Avg PF"];
    for (const m of r.meters) {
      for (const d of m.days) {
        lines.push(
          [m.meter.name, d.day, d.importKwh ?? "", d.exportKwh ?? "", d.maxDemandKw ?? "", d.avgPowerFactor ?? ""]
            .map(csvCell)
            .join(","),
        );
      }
      lines.push([m.meter.name, "TOTAL", m.totalImportKwh, m.totalExportKwh, m.maxDemandKw, ""].map(csvCell).join(","));
    }
    return lines.join("\n");
  }, [report.data]);

  const download = () => {
    const blob = new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `energy-report-${from}_${to}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t.reports.title}</h1>
        <p className="text-sm text-slate-500">{t.reports.subtitle}</p>
      </div>

      <Card>
        <CardContent className="grid items-end gap-4 p-4 md:grid-cols-6">
          <div className="space-y-2">
            <Label>{t.reports.scope}</Label>
            <Select value={scope} onValueChange={(v) => setScope(v as "meter" | "site")}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="meter">{t.reports.byMeter}</SelectItem>
                <SelectItem value="site">{t.reports.bySite}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>{scope === "meter" ? t.meters.title : t.common.sites}</Label>
            {scope === "meter" ? (
              <Select value={meterId} onValueChange={setMeterId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(meters.data ?? []).map((m) => (
                    <SelectItem key={m.id} value={String(m.id)}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Select value={siteId} onValueChange={setSiteId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(sites.data ?? []).map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
          <div className="space-y-2">
            <Label>{t.reports.from}</Label>
            <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>{t.reports.to}</Label>
            <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <Button className="gap-2" disabled={!ready || report.isFetching} onClick={() => setRun((n) => n + 1)}>
            <Play className="h-4 w-4" /> {t.reports.generate}
          </Button>
          <Button variant="outline" className="gap-2" disabled={!csv} onClick={download}>
            <Download className="h-4 w-4" /> {t.common.exportCsv}
          </Button>
        </CardContent>
      </Card>

      {!report.data && <p className="text-sm text-slate-500">{t.reports.selectScope}</p>}

      {report.data && (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-slate-600">{t.reports.reportFor}</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="text-xl font-bold">{report.data.scopeLabel}</div>
                <p className="text-xs text-slate-500">
                  {t.reports.period}: {from} → {to}
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-slate-600">{t.reports.importKwh}</CardTitle>
              </CardHeader>
              <CardContent className="text-xl font-bold">{fmt(report.data.totalImportKwh, 1)} kWh</CardContent>
            </Card>
            <Card>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-slate-600">{t.reports.exportKwh}</CardTitle>
              </CardHeader>
              <CardContent className="text-xl font-bold">{fmt(report.data.totalExportKwh, 1)} kWh</CardContent>
            </Card>
          </div>

          {report.data.meters.map((m) => (
            <Card key={m.meter.id}>
              <CardHeader>
                <CardTitle className="text-base">
                  {m.meter.name}{" "}
                  <span className="ml-2 text-sm font-normal text-slate-500">
                    {t.common.total}: {fmt(m.totalImportKwh, 1)} kWh · {t.reports.maxDemand}:{" "}
                    {fmt(m.maxDemandKw, 1)}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t.reports.day}</TableHead>
                      <TableHead className="text-right">{t.reports.importKwh}</TableHead>
                      <TableHead className="text-right">{t.reports.exportKwh}</TableHead>
                      <TableHead className="text-right">{t.reports.maxDemand}</TableHead>
                      <TableHead className="text-right">{t.reports.avgPf}</TableHead>
                      <TableHead className="text-right">{t.reports.samples}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {m.days.map((d) => (
                      <TableRow key={d.day}>
                        <TableCell>{d.day}</TableCell>
                        <TableCell className="text-right">
                          {fmt(d.importKwh, 1)}
                          {/* v7/C7: counter reset/meter swap detected this day — totals
                              are sums of non-negative deltas; flag the estimate. */}
                          {d.counterReset && (
                            <span className="ml-1 text-xs text-amber-600" title={t.reports.counterResetNote}>
                              ↺
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">{fmt(d.exportKwh, 1)}</TableCell>
                        <TableCell className="text-right">
                          {fmt(d.maxDemandKw, 1)}
                          {/* #21: demand derived from active power (device has
                              no demand register) — label it, don't blend it. */}
                          {d.demandDerived && (
                            <span className="ml-1 text-xs text-amber-600" title="Derived from active power — no demand register samples">
                              ≈
                            </span>
                          )}
                        </TableCell>
                        <TableCell className="text-right">{fmt(d.avgPowerFactor, 3)}</TableCell>
                        <TableCell className="text-right">{d.samples}</TableCell>
                      </TableRow>
                    ))}
                    {m.days.length === 0 && (
                      <TableRow>
                        <TableCell colSpan={6} className="py-8 text-center text-sm text-slate-500">
                          {t.common.noData}
                        </TableCell>
                      </TableRow>
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          ))}
        </>
      )}
    </div>
  );
}
