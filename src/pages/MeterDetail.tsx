import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { StatusBadge, DeviceTypeBadge, fmt, fmtTime } from "@/components/shared";
import { ControlPanel } from "@/components/ControlPanel";
import { EmsPanel } from "@/components/EmsPanel";
import { EmsPlanCard } from "@/components/EmsPlanCard";
import { METRIC_UNITS } from "@contracts/modbus";
import { EXTENDED_METRIC_UNITS, PRIMARY_POWER_KEY } from "@contracts/devices";
import type { DeviceType } from "@contracts/devices";
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
  const vals = (v?.values ?? {}) as Record<string, number>;
  const deviceType = (meter.deviceType ?? "meter") as string;
  const is3ph = meter.phases === "three";
  const g = (k: string) => (vals[k] !== undefined ? vals[k] : undefined);

  const meterTiles: { label: string; value: string; unit: string }[] = [
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

  const inverterTiles = [
    { label: t.meters.activePower, value: fmt(g("activePowerKw")), unit: "kW" },
    { label: "DC " + t.meters.activePower, value: fmt(g("dcPowerKw")), unit: "kW" },
    { label: `${t.devices.dcSide} 1 (V/A)`, value: g("dcVoltageMppt1") !== undefined ? `${fmt(g("dcVoltageMppt1"), 0)} / ${fmt(g("dcCurrentMppt1"), 1)}` : "—", unit: "" },
    { label: `${t.devices.dcSide} 2 (V/A)`, value: g("dcVoltageMppt2") !== undefined ? `${fmt(g("dcVoltageMppt2"), 0)} / ${fmt(g("dcCurrentMppt2"), 1)}` : "—", unit: "" },
    { label: t.devices.energyToday, value: fmt(g("energyTodayKwh"), 1), unit: "kWh" },
    { label: t.devices.energyTotal, value: fmt(g("energyTotalKwh"), 0), unit: "kWh" },
    { label: t.meters.frequency, value: fmt(g("frequencyHz"), 2), unit: "Hz" },
    { label: t.devices.heatsink + " °C", value: fmt(g("heatsinkTempC"), 1), unit: "°C" },
    { label: t.devices.status, value: fmt(g("statusCode"), 0), unit: "" },
    { label: t.devices.fault, value: fmt(g("faultCode"), 0), unit: "" },
  ];

  const battP = g("batteryPowerKw");
  const battState = battP === undefined ? "" : battP > 0.05 ? t.devices.discharging : battP < -0.05 ? t.devices.charging : t.devices.idle;
  const bessTiles = [
    { label: t.devices.soc, value: fmt(g("socPercent"), 1), unit: "%" },
    { label: t.devices.soh, value: fmt(g("sohPercent"), 1), unit: "%" },
    { label: `${t.devices.batteryPower} (${battState})`, value: fmt(battP), unit: "kW" },
    { label: `${t.meters.voltage} / ${t.meters.current}`, value: g("batteryVoltageV") !== undefined ? `${fmt(g("batteryVoltageV"), 1)} V / ${fmt(g("batteryCurrentA"), 1)} A` : "—", unit: "" },
    { label: t.devices.cellTemps, value: g("cellTempMinC") !== undefined ? `${fmt(g("cellTempMinC"), 1)} / ${fmt(g("cellTempMaxC"), 1)}` : "—", unit: "°C" },
    { label: t.devices.cycles, value: fmt(g("cyclesCount"), 0), unit: "" },
    { label: `${t.devices.energyTotal} ↓`, value: fmt(g("dischargeEnergyTotalKwh"), 0), unit: "kWh" },
    { label: `${t.devices.energyTotal} ↑`, value: fmt(g("chargeEnergyTotalKwh"), 0), unit: "kWh" },
    { label: t.devices.fault, value: fmt(g("faultCode"), 0), unit: "" },
  ];

  const tiles = deviceType === "inverter" ? inverterTiles : deviceType === "bess" ? bessTiles : meterTiles;

  // #20: which key powers the history chart for this device type.
  const primaryKey = PRIMARY_POWER_KEY[deviceType as DeviceType] ?? "activePowerKw";
  const primaryUnit =
    (EXTENDED_METRIC_UNITS as Record<string, string>)[primaryKey] ??
    (METRIC_UNITS as Record<string, string>)[primaryKey] ??
    "kW";
  const primaryKeyLabel =
    primaryKey === "batteryPowerKw"
      ? t.devices.batteryPower
      : primaryKey === "irradianceWm2"
        ? "Irradiance"
        : t.meters.activePower;

  // Generic fallback table — every decoded register, for any device type.
  const allUnits: Record<string, string> = { ...METRIC_UNITS, ...EXTENDED_METRIC_UNITS };
  const allRows = Object.entries(vals).sort(([a], [b]) => a.localeCompare(b));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <Link to="/meters" className="mb-1 inline-flex items-center gap-1 text-xs text-slate-500 hover:underline">
            <ArrowLeft className="h-3 w-3" /> {t.meters.title}
          </Link>
          <h1 className="flex items-center gap-3 text-2xl font-bold tracking-tight">
            {meter.name} <StatusBadge status={meter.status} /> <DeviceTypeBadge type={deviceType} />
          </h1>
          <p className="text-sm text-slate-500">
            {meter.brand ? `${meter.brand} · ` : ""}
            {meter.model} ·{" "}
            {meter.host
              ? `${meter.host}:${meter.port ?? 502} · unit ${meter.unitId ?? 1}`
              : `${meter.gatewayName} · ${t.meters.modbusAddress} ${meter.modbusAddress}`}
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

      {/* v7/C12: active control — renders only when the model has a writable whitelist */}
      <ControlPanel meterId={meterId} />

      {/* v8/D1: EMS automation — renders only for BESS-type devices */}
      <EmsPanel meterId={meterId} deviceType={deviceType} />

      {/* v9.1: optimizer-pushed EMS plan (Contract A) — visible for BESS devices */}
      {deviceType === "bess" && <EmsPlanCard meterId={meterId} />}

      {deviceType !== "meter" && allRows.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>{t.devices.allValues}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-x-8 gap-y-1 text-sm sm:grid-cols-3 lg:grid-cols-4">
              {allRows.map(([k, val]) => (
                <div key={k} className="flex justify-between border-b border-slate-100 py-1">
                  <span className="font-mono text-xs text-slate-500">{k}</span>
                  <span className="font-medium">
                    {fmt(val)} <span className="text-xs font-normal text-slate-400">{allUnits[k] ?? ""}</span>
                  </span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* #20: the series follows the device's PRIMARY_POWER_KEY (BESS →
          batteryPowerKw), surfaced by the API as `powerKw`. */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>
            {t.meters.history} — {primaryKeyLabel}
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
                <YAxis fontSize={12} stroke="#94a3b8" unit={` ${primaryUnit}`} width={80} />
                <Tooltip
                  labelFormatter={(val) => fmtTime(val as Date)}
                  formatter={(value) => [`${value} ${primaryUnit}`, primaryKeyLabel]}
                />
                <Line
                  type="monotone"
                  dataKey="powerKw"
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
