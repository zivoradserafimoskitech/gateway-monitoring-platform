import { useState } from "react";
import { Link } from "react-router";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { StatCard, SeverityBadge, fmtTime } from "@/components/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Zap, Radio, Gauge, BellRing, Activity, Network } from "lucide-react";
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";

type Range = 1 | 24 | 168;

export default function Dashboard() {
  const { t } = useI18n();
  const [hours, setHours] = useState<Range>(24);
  const overview = trpc.dashboard.overview.useQuery(undefined, { refetchInterval: 5000 });
  const trend = trpc.dashboard.powerTrend.useQuery({ hours }, { refetchInterval: 15000 });
  const recent = trpc.dashboard.recentAlarms.useQuery(undefined, { refetchInterval: 10000 });
  const sites = trpc.sites.list.useQuery();

  const o = overview.data;
  const rangeButtons: { value: Range; label: string }[] = [
    { value: 1, label: t.dashboard.lastHour },
    { value: 24, label: t.dashboard.last24h },
    { value: 168, label: t.dashboard.last7d },
  ];

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">{t.dashboard.title}</h1>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        <StatCard title={t.dashboard.totalPower} value={o?.totalPowerKw ?? "—"} unit="kW" icon={Zap} />
        <StatCard title={t.dashboard.energyToday} value={o?.energyTodayKwh ?? "—"} unit="kWh" icon={Activity} />
        <StatCard
          title={t.dashboard.gatewaysOnline}
          value={`${o?.gatewaysOnline ?? 0} / ${o?.gatewaysTotal ?? 0}`}
          icon={Radio}
        />
        <StatCard
          title={t.dashboard.metersOnline}
          value={`${o?.metersOnline ?? 0} / ${o?.metersTotal ?? 0}`}
          icon={Gauge}
        />
        <StatCard title={t.dashboard.activeAlarms} value={o?.activeAlarms ?? 0} icon={BellRing} />
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>{t.dashboard.powerTrend}</CardTitle>
          <div className="flex gap-2">
            {rangeButtons.map((b) => (
              <Button
                key={b.value}
                size="sm"
                variant={hours === b.value ? "default" : "outline"}
                onClick={() => setHours(b.value)}
              >
                {b.label}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={trend.data ?? []}>
                <defs>
                  <linearGradient id="power" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#10b981" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#10b981" stopOpacity={0.02} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis
                  dataKey="ts"
                  tickFormatter={(v: Date) =>
                    new Date(v).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                  }
                  fontSize={12}
                  stroke="#94a3b8"
                />
                <YAxis fontSize={12} stroke="#94a3b8" unit=" kW" width={80} />
                <Tooltip
                  labelFormatter={(v) => fmtTime(v as Date)}
                  formatter={(value) => [`${value} kW`, t.meters.activePower]}
                />
                <Area
                  type="monotone"
                  dataKey="powerKw"
                  stroke="#10b981"
                  strokeWidth={2}
                  fill="url(#power)"
                  connectNulls
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>

      {(sites.data ?? []).length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t.common.sites}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y">
              {(sites.data ?? []).map((s) => (
                <li key={s.id} className="flex items-center justify-between py-3">
                  <p className="text-sm font-medium">{s.name}</p>
                  <Button variant="ghost" size="sm" asChild title={t.dashboardExtra.openDiagramHint}>
                    <Link to={`/sites/${s.id}/diagram`} className="gap-2">
                      <Network className="h-4 w-4" /> {t.dashboardExtra.openDiagram}
                    </Link>
                  </Button>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle>{t.dashboard.recentAlarms}</CardTitle>
        </CardHeader>
        <CardContent>
          {(recent.data ?? []).length === 0 ? (
            <p className="py-6 text-center text-sm text-slate-500">{t.dashboard.noAlarms}</p>
          ) : (
            <ul className="divide-y">
              {(recent.data ?? []).map((a) => (
                <li key={a.id} className="flex items-center justify-between py-3">
                  <div>
                    <p className="text-sm font-medium">{a.message}</p>
                    <p className="text-xs text-slate-500">
                      {a.meterName ?? a.gatewayName ?? "—"} · {fmtTime(a.triggeredAt)}
                    </p>
                  </div>
                  <SeverityBadge severity={a.severity} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
