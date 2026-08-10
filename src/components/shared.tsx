import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useI18n } from "@/i18n";
import type { LucideIcon } from "lucide-react";

export function StatusBadge({ status }: { status: "online" | "offline" }) {
  const { t } = useI18n();
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium",
        status === "online" ? "bg-emerald-100 text-emerald-700" : "bg-slate-200 text-slate-600",
      )}
    >
      <span
        className={cn("h-1.5 w-1.5 rounded-full", status === "online" ? "bg-emerald-500" : "bg-slate-400")}
      />
      {status === "online" ? t.common.online : t.common.offline}
    </span>
  );
}

export function DeviceTypeBadge({ type }: { type: string }) {
  const { t } = useI18n();
  const styles: Record<string, string> = {
    meter: "bg-sky-100 text-sky-700",
    inverter: "bg-amber-100 text-amber-700",
    bess: "bg-violet-100 text-violet-700",
    weather: "bg-teal-100 text-teal-700",
  };
  const labels: Record<string, string> = {
    meter: t.devices.meter,
    inverter: t.devices.inverter,
    bess: t.devices.bess,
    weather: t.devices.weather,
  };
  return (
    <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-medium", styles[type] ?? "bg-slate-200 text-slate-600")}>
      {labels[type] ?? type}
    </span>
  );
}

export function SeverityBadge({ severity }: { severity: "info" | "warning" | "critical" }) {
  const { t } = useI18n();
  const styles = {
    info: "bg-blue-100 text-blue-700",
    warning: "bg-amber-100 text-amber-700",
    critical: "bg-red-100 text-red-700",
  } as const;
  const labels = { info: t.alarms.info, warning: t.alarms.warning, critical: t.alarms.critical };
  return (
    <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-medium", styles[severity])}>
      {labels[severity]}
    </span>
  );
}

export function AlarmStatusBadge({ status }: { status: "active" | "acknowledged" | "resolved" }) {
  const { t } = useI18n();
  const styles = {
    active: "bg-red-100 text-red-700",
    acknowledged: "bg-amber-100 text-amber-700",
    resolved: "bg-emerald-100 text-emerald-700",
  } as const;
  const labels = {
    active: t.common.active,
    acknowledged: t.common.acknowledged,
    resolved: t.common.resolved,
  };
  return (
    <span className={cn("rounded-full px-2.5 py-0.5 text-xs font-medium", styles[status])}>
      {labels[status]}
    </span>
  );
}

export function StatCard({
  title,
  value,
  unit,
  icon: Icon,
  hint,
}: {
  title: string;
  value: string | number;
  unit?: string;
  icon: LucideIcon;
  hint?: string;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-slate-600">{title}</CardTitle>
        <Icon className="h-4 w-4 text-slate-400" />
      </CardHeader>
      <CardContent>
        <div className="text-2xl font-bold tracking-tight">
          {value}
          {unit ? <span className="ml-1 text-sm font-normal text-slate-500">{unit}</span> : null}
        </div>
        {hint ? <p className="mt-1 text-xs text-slate-500">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

export function fmt(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return n.toLocaleString(undefined, { maximumFractionDigits: digits });
}

export function fmtTime(d: Date | string | null | undefined): string {
  if (!d) return "—";
  const date = typeof d === "string" ? new Date(d) : d;
  return date.toLocaleString();
}
