import { useMemo, useState } from "react";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { SeverityBadge, AlarmStatusBadge, fmt, fmtTime } from "@/components/shared";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
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
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { METRIC_UNITS, type MetricKey } from "@contracts/modbus";
import { EXTENDED_METRIC_UNITS } from "@contracts/devices";

// #19: rule metrics are an open key space — the dropdown is populated from the
// actual device-profile register maps (all of them, or the selected meter's),
// not a hardcoded list of 14 meter metrics.
interface RegDefLike {
  key: string;
  unit?: string;
}

function useMetricOptions(meterId: string, metersData: { id: number; model: string }[] | undefined) {
  const profiles = trpc.profiles.list.useQuery();
  return useMemo(() => {
    const units: Record<string, string> = { ...METRIC_UNITS, ...EXTENDED_METRIC_UNITS };
    const keys = new Set<string>();
    const selected =
      meterId !== "all" ? (metersData ?? []).find((m) => m.id === Number(meterId)) : undefined;
    const allProfiles = (profiles.data ?? []) as { model: string; registerMap: RegDefLike[] }[];
    const relevant = selected ? allProfiles.filter((p) => p.model === selected.model) : allProfiles;
    for (const p of relevant) {
      for (const d of p.registerMap ?? []) {
        keys.add(d.key);
        if (d.unit) units[d.key] = d.unit;
      }
    }
    if (keys.size === 0) for (const k of Object.keys(METRIC_UNITS)) keys.add(k);
    keys.add("gatewayOffline");
    return { keys: [...keys].sort(), units };
  }, [meterId, metersData, profiles.data]);
}

export default function Alarms() {
  const { t } = useI18n();
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold tracking-tight">{t.alarms.title}</h1>
      <Tabs defaultValue="active">
        <TabsList>
          <TabsTrigger value="active">{t.common.active}</TabsTrigger>
          <TabsTrigger value="acknowledged">{t.common.acknowledged}</TabsTrigger>
          <TabsTrigger value="resolved">{t.common.resolved}</TabsTrigger>
          <TabsTrigger value="rules">{t.alarms.rules}</TabsTrigger>
        </TabsList>
        <TabsContent value="active">
          <EventsTable status="active" />
        </TabsContent>
        <TabsContent value="acknowledged">
          <EventsTable status="acknowledged" />
        </TabsContent>
        <TabsContent value="resolved">
          <EventsTable status="resolved" />
        </TabsContent>
        <TabsContent value="rules">
          <RulesTable />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function EventsTable({ status }: { status: "active" | "acknowledged" | "resolved" }) {
  const { t } = useI18n();
  const utils = trpc.useUtils();
  const events = trpc.alarms.list.useQuery({ status, limit: 200 }, { refetchInterval: 5000 });
  const ack = trpc.alarms.acknowledge.useMutation({
    onSuccess: () => utils.alarms.list.invalidate(),
  });
  const resolve = trpc.alarms.resolve.useMutation({
    onSuccess: () => utils.alarms.list.invalidate(),
  });

  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.alarms.severity}</TableHead>
              <TableHead>{t.alarms.message}</TableHead>
              <TableHead>{t.meters.title}</TableHead>
              <TableHead>{t.alarms.value}</TableHead>
              <TableHead>{t.alarms.triggeredAt}</TableHead>
              <TableHead>{t.common.status}</TableHead>
              <TableHead className="text-right">{t.common.actions}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(events.data ?? []).map((a) => (
              <TableRow key={a.id}>
                <TableCell>
                  <SeverityBadge severity={a.severity} />
                </TableCell>
                <TableCell className="max-w-md text-sm">{a.message}</TableCell>
                <TableCell className="text-sm">{a.meterName ?? a.gatewayName ?? "—"}</TableCell>
                <TableCell className="text-sm">
                  {a.value !== null && a.value !== undefined
                    ? `${fmt(a.value)} ${METRIC_UNITS[a.metric as MetricKey] ?? ""}`
                    : "—"}
                </TableCell>
                <TableCell className="text-xs">{fmtTime(a.triggeredAt)}</TableCell>
                <TableCell>
                  <AlarmStatusBadge status={a.status} />
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-1">
                    {a.status === "active" && (
                      <Button size="sm" variant="outline" onClick={() => ack.mutate({ id: a.id })}>
                        {t.alarms.acknowledge}
                      </Button>
                    )}
                    {a.status !== "resolved" && (
                      <Button size="sm" variant="ghost" onClick={() => resolve.mutate({ id: a.id })}>
                        {t.alarms.resolve}
                      </Button>
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {(events.data ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="py-10 text-center text-sm text-slate-500">
                  {t.alarms.noEvents}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function RulesTable() {
  const { t } = useI18n();
  const utils = trpc.useUtils();
  const rules = trpc.alarms.listRules.useQuery(undefined, { refetchInterval: 10000 });
  const meters = trpc.meters.list.useQuery();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [metric, setMetric] = useState<string>("voltageL1");
  const [operator, setOperator] = useState<"gt" | "lt">("gt");
  const [threshold, setThreshold] = useState("253");
  const [severity, setSeverity] = useState<"info" | "warning" | "critical">("warning");
  const [meterId, setMeterId] = useState<string>("all");
  const metricOptions = useMetricOptions(meterId, meters.data);

  const create = trpc.alarms.createRule.useMutation({
    onSuccess: () => {
      utils.alarms.listRules.invalidate();
      setOpen(false);
      setName("");
      toast.success(t.common.save);
    },
    onError: (e) => toast.error(e.message),
  });
  const toggle = trpc.alarms.toggleRule.useMutation({
    onSuccess: () => utils.alarms.listRules.invalidate(),
  });
  const del = trpc.alarms.deleteRule.useMutation({
    onSuccess: () => utils.alarms.listRules.invalidate(),
  });

  return (
    <Card>
      <CardContent className="space-y-4 p-4">
        <div className="flex justify-end">
          <Button onClick={() => setOpen(true)} className="gap-2">
            <Plus className="h-4 w-4" /> {t.alarms.addRule}
          </Button>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.common.name}</TableHead>
              <TableHead>{t.alarms.metric}</TableHead>
              <TableHead>{t.alarms.operator}</TableHead>
              <TableHead>{t.alarms.threshold}</TableHead>
              <TableHead>{t.alarms.severity}</TableHead>
              <TableHead>{t.alarms.appliesTo}</TableHead>
              <TableHead>{t.common.status}</TableHead>
              <TableHead className="text-right">{t.common.actions}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(rules.data ?? []).map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-medium">{r.name}</TableCell>
                <TableCell className="font-mono text-xs">
                  {r.metric === "gatewayOffline" ? t.alarms.gatewayOffline : r.metric}
                </TableCell>
                <TableCell>{r.operator === "gt" ? ">" : "<"}</TableCell>
                <TableCell>
                  {r.threshold} {METRIC_UNITS[r.metric as MetricKey] ?? ""}
                </TableCell>
                <TableCell>
                  <SeverityBadge severity={r.severity} />
                </TableCell>
                <TableCell className="text-sm">{r.meterName ?? t.alarms.allMeters}</TableCell>
                <TableCell>
                  <Switch
                    checked={r.enabled}
                    onCheckedChange={(v) => toggle.mutate({ id: r.id, enabled: v })}
                  />
                </TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="icon" onClick={() => del.mutate({ id: r.id })}>
                    <Trash2 className="h-4 w-4 text-slate-400" />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {(rules.data ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={8} className="py-10 text-center text-sm text-slate-500">
                  {t.common.noData}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>

        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t.alarms.addRule}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-2">
                <Label>{t.common.name}</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Overvoltage" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>{t.alarms.metric}</Label>
                  <Select value={metric} onValueChange={setMetric}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {metricOptions.keys.map((m) => (
                        <SelectItem key={m} value={m}>
                          {m} {metricOptions.units[m] ? `(${metricOptions.units[m]})` : ""}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label>{t.alarms.operator}</Label>
                  <Select value={operator} onValueChange={(v) => setOperator(v as "gt" | "lt")}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="gt">&gt; {t.alarms.gt}</SelectItem>
                      <SelectItem value="lt">&lt; {t.alarms.lt}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div className="space-y-2">
                  <Label>{t.alarms.threshold}</Label>
                  <Input type="number" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
                </div>
                <div className="space-y-2">
                  <Label>{t.alarms.severity}</Label>
                  <Select value={severity} onValueChange={(v) => setSeverity(v as typeof severity)}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="info">{t.alarms.info}</SelectItem>
                      <SelectItem value="warning">{t.alarms.warning}</SelectItem>
                      <SelectItem value="critical">{t.alarms.critical}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="space-y-2">
                <Label>{t.alarms.appliesTo}</Label>
                <Select value={meterId} onValueChange={setMeterId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t.alarms.allMeters}</SelectItem>
                    {(meters.data ?? []).map((m) => (
                      <SelectItem key={m.id} value={String(m.id)}>
                        {m.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button variant="outline" onClick={() => setOpen(false)}>
                {t.common.cancel}
              </Button>
              <Button
                disabled={!name.trim() || create.isPending}
                onClick={() =>
                  create.mutate({
                    name: name.trim(),
                    metric,
                    operator,
                    threshold: Number(threshold),
                    severity,
                    meterId: meterId === "all" ? null : Number(meterId),
                  })
                }
              >
                {t.common.save}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardContent>
    </Card>
  );
}
