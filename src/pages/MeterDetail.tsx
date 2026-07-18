import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { StatusBadge, fmt, fmtTime } from "@/components/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from "recharts";
import { ArrowLeft } from "lucide-react";

type RangeKey = "1h" | "24h" | "7d";
const RANGE_HOURS: Record<RangeKey, number> = { "1h": 1, "24h": 24, "7d": 168 };

export default function MeterDetail() {
  const { id } = useParams<{ id: string }>();
  const meterId = Number(id);
  const { t } = useI18n();
  const [range, setRange] = useState<RangeKey>("24h");

  const meters = trpc.meters.list.useQuery(undefined, { refetchInterval: 10000 });
  const meter = (meters.data ?? []).find((m) => m.id === meterId);
  const latest = trpc.meters.latest.useQuery({ meterId }, { refetchInterval: 5000 });

  // Stable query window: tick every 15 s, otherwise `new Date()` per render
  // would change the query key on every render and the chart would never settle.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const i = setInterval(() => setTick((n) => n + 1), 15000);
    return () => clearInterval(i);
  }, []);
  const { from, to } = useMemo(() => {
    const to = new Date();
    return { from: new Date(to.getTime() - RANGE_HOURS[range] * 3600_000), to };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, tick]);
  const history = trpc.meters.history.useQuery(
    { meterId, from, to, buckets: 120 },
    { placeholderData: (prev) => prev },
  );

  if (!meter) return <p className="text-sm text-slate-500">{t.common.loading}</p>;
  const v = latest.data;
  const is3ph = meter.phases === "three";

  const tiles: { label: string; value: string; unit: string }[] = [
    ...(is3ph
      ? [
          { label: `${t.meters.voltage} L1/L2/L3`, value: v ? `${fmt(v.voltageL1, 1)} / ${fmt(v.voltageL2, 1)} / ${fmt(v.voltageL3, 1)}` : "—", unit: "V" },
          { label: `${t.meters.current} L1/L2/L3`, value: v ? `${fmt(v.currentL1, 1)} / ${fmt(v.currentL2, 1)} / ${fmt(v.currentL3, 1)}` : "—", unit: "A" },
        ]
      : [
          { label: t.meters.voltage, value: fmt(v?.voltageL1, 1), unit: "V" },
          { label: t.meters.current, value: fmt(v?.currentL1, 1), unit: "A" },
        ]),
    { label: t.meters.activePower, value: fmt(v?.activePowerKw), unit: "kW" },
    { label: t.meters.reactivePower, value: fmt(v?.reactivePowerKvar), unit: "kvar" },
    { label: t.meters.apparentPower, value: fmt(v?.apparentPowerKva), unit: "kVA" },
    { label: t.meters.powerFactor, value: fmt(v?.powerFactor, 3), unit: "" },
    { label: t.meters.frequency, value: fmt(v?.frequencyHz, 2), unit: "Hz" },
    { label: t.meters.energyImport, value: fmt(v?.energyImportKwh, 1), unit: "kWh" },
    { label: t.meters.energyExport, value: fmt(v?.energyExportKwh, 1), unit: "kWh" },
    { label: t.meters.demand, value: fmt(v?.demandKw), unit: "kW" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link to="/meters" className="mb-1 inline-flex items-center gap-1 text-xs text-slate-500 hover:underline">
            <ArrowLeft className="h-3 w-3" /> {t.meters.title}
          </Link>
          <h1 className="flex items-center gap-3 text-2xl font-bold tracking-tight">
            {meter.name} <StatusBadge status={meter.status} />
          </h1>
          <p className="text-sm text-slate-500">
            {meter.model} · {meter.gatewayName} · {t.meters.modbusAddress} {meter.modbusAddress}
            {v ? ` · ${t.meters.updatedAt} ${fmtTime(v.ts)}` : ""}
          </p>
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5">
        {tiles.map((tile) => (
          <Card key={tile.label}>
            <CardHeader className="pb-1 pt-4">
              <CardTitle className="text-xs font-medium text-slate-500">{tile.label}</CardTitle>
            </CardHeader>
            <CardContent className="pb-4">
              <div className="text-xl font-semibold">
                {tile.value} <span className="text-xs font-normal text-slate-400">{tile.unit}</span>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>
            {t.meters.history} — {t.meters.activePower}
          </CardTitle>
          <div className="flex gap-2">
            {(["1h", "24h", "7d"] as RangeKey[]).map((r) => (
              <Button key={r} size="sm" variant={range === r ? "default" : "outline"} onClick={() => setRange(r)}>
                {r === "1h" ? t.dashboard.lastHour : r === "24h" ? t.dashboard.last24h : t.dashboard.last7d}
              </Button>
            ))}
          </div>
        </CardHeader>
        <CardContent>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={history.data ?? []}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis
                  dataKey="ts"
                  tickFormatter={(val: Date) =>
                    new Date(val).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
                  }
                  fontSize={12}
                  stroke="#94a3b8"
                />
                <YAxis fontSize={12} stroke="#94a3b8" unit=" kW" width={80} />
                <Tooltip
                  labelFormatter={(val) => fmtTime(val as Date)}
                  formatter={(value) => [`${value} kW`, t.meters.activePower]}
                />
                <Line
                  type="monotone"
                  dataKey="activePowerKw"
                  stroke="#10b981"
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
