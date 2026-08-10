import { useMemo, useState } from "react";
import { Link } from "react-router";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { StatusBadge, DeviceTypeBadge, fmtTime } from "@/components/shared";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Plus } from "lucide-react";
import { toast } from "sonner";

const TYPE_FILTERS = ["all", "meter", "inverter", "bess", "weather"] as const;

export default function Meters() {
  const { t } = useI18n();
  const [typeFilter, setTypeFilter] = useState<(typeof TYPE_FILTERS)[number]>("all");
  const meters = trpc.meters.list.useQuery(undefined, { refetchInterval: 5000 });

  const rows = useMemo(() => {
    const all = meters.data ?? [];
    return typeFilter === "all" ? all : all.filter((m) => (m.deviceType ?? "meter") === typeFilter);
  }, [meters.data, typeFilter]);

  const typeLabel = (ty: string) =>
    ty === "all"
      ? t.devices.allTypes
      : (t.devices as Record<string, string>)[ty] ?? ty;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t.meters.title}</h1>
          <p className="text-sm text-slate-500">{t.meters.subtitle}</p>
        </div>
        <AddDeviceDialog />
      </div>

      <Tabs value={typeFilter} onValueChange={(v) => setTypeFilter(v as typeof typeFilter)}>
        <TabsList>
          {TYPE_FILTERS.map((ty) => (
            <TabsTrigger key={ty} value={ty}>
              {typeLabel(ty)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.common.status}</TableHead>
                <TableHead>{t.common.name}</TableHead>
                <TableHead>{t.devices.type}</TableHead>
                <TableHead>{t.devices.brand}</TableHead>
                <TableHead>{t.common.model}</TableHead>
                <TableHead>{t.devices.connection}</TableHead>
                <TableHead>{t.common.site}</TableHead>
                <TableHead>{t.common.lastSeen}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>
                    <StatusBadge status={m.status} />
                  </TableCell>
                  <TableCell>
                    <Link to={`/meters/${m.id}`} className="font-medium text-emerald-700 hover:underline">
                      {m.name}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <DeviceTypeBadge type={m.deviceType ?? "meter"} />
                  </TableCell>
                  <TableCell>{m.brand ?? "—"}</TableCell>
                  <TableCell className="text-xs">{m.model}</TableCell>
                  <TableCell className="text-xs">
                    {m.host ? (
                      <span className="font-mono">
                        {m.host}:{m.port ?? 502} · unit {m.unitId ?? 1}
                      </span>
                    ) : (
                      <>
                        <Link to={`/gateways/${m.gatewayId}`} className="text-emerald-700 hover:underline">
                          {m.gatewayName}
                        </Link>
                        <span className="ml-1 font-mono text-slate-400">#{m.modbusAddress}</span>
                      </>
                    )}
                  </TableCell>
                  <TableCell>{m.siteName ?? "—"}</TableCell>
                  <TableCell className="text-xs">{m.lastSeenAt ? fmtTime(m.lastSeenAt) : t.common.never}</TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="py-10 text-center text-sm text-slate-500">
                    {t.common.noData}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function AddDeviceDialog() {
  const { t } = useI18n();
  const utils = trpc.useUtils();
  const [open, setOpen] = useState(false);
  const profiles = trpc.profiles.list.useQuery(undefined, { enabled: open });
  const gateways = trpc.gateways.list.useQuery(undefined, { enabled: open });
  const sites = trpc.sites.list.useQuery(undefined, { enabled: open });

  const [profileModel, setProfileModel] = useState("");
  const [name, setName] = useState("");
  const [siteId, setSiteId] = useState("none");
  const [conn, setConn] = useState<"bus" | "tcp">("bus");
  const [gatewayId, setGatewayId] = useState("");
  const [address, setAddress] = useState("1");
  const [host, setHost] = useState("");
  const [port, setPort] = useState("502");
  const [unitId, setUnitId] = useState("1");
  const [interval, setIntervalSec] = useState("60");

  const profile = (profiles.data ?? []).find((p) => p.model === profileModel);
  const isTcpProfile = profile?.protocol === "tcp";
  const busGateways = (gateways.data ?? []).filter((g) => g.uid !== "direct-tcp");

  const create = trpc.meters.create.useMutation({
    onSuccess: () => {
      utils.meters.list.invalidate();
      toast.success(t.devices.deviceCreated);
      setOpen(false);
    },
    onError: (e) => toast.error(e.message),
  });

  // v7/C4: probe the device before saving
  const [testResult, setTestResult] = useState<{ ok: boolean; ms: number; values?: Record<string, number>; error?: string } | null>(null);
  const test = trpc.meters.testConnection.useMutation({
    onSuccess: (r) => setTestResult(r),
    onError: (e) => setTestResult({ ok: false, ms: 0, error: e.message }),
  });
  const runTest = () => {
    if (!profile) return;
    setTestResult(null);
    test.mutate(
      conn === "tcp"
        ? { model: profile.model, host, port: Number(port) || 502, unitId: Number(unitId) || 1 }
        : { model: profile.model, gatewayId: Number(gatewayId) },
    );
  };

  const submit = () => {
    if (!profile) return;
    create.mutate({
      name: name || `${profile.brand ?? profile.model} ${profile.model}`,
      model: profile.model,
      deviceType: (profile.deviceType as "meter" | "inverter" | "bess" | "weather") ?? "meter",
      brand: profile.brand ?? undefined,
      siteId: siteId === "none" ? null : Number(siteId),
      ...(conn === "tcp"
        ? {
            host,
            port: Number(port) || 502,
            unitId: Number(unitId) || 1,
            pollIntervalSec: Math.max(5, Number(interval) || 60),
          }
        : {
            gatewayId: Number(gatewayId),
            modbusAddress: Number(address) || 1,
          }),
    });
  };

  const valid =
    profile &&
    (conn === "tcp" ? host.trim().length > 0 : gatewayId !== "") &&
    (conn === "bus" || true);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button className="gap-2">
          <Plus className="h-4 w-4" /> {t.devices.addDevice}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{t.devices.addDevice}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label>{t.devices.profile}</Label>
            <Select value={profileModel} onValueChange={setProfileModel}>
              <SelectTrigger>
                <SelectValue placeholder="Huawei / Sungrow / SMA / ..." />
              </SelectTrigger>
              <SelectContent className="max-h-72">
                {(profiles.data ?? []).map((p) => (
                  <SelectItem key={p.model} value={p.model}>
                    <span className="font-medium">{p.brand ?? ""}</span> {p.label}
                    <span className="ml-2 text-xs text-slate-400">
                      {p.deviceType} · {p.protocol}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>{t.common.name}</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder={profile?.label ?? ""} />
          </div>

          <div className="space-y-1.5">
            <Label>{t.devices.siteOptional}</Label>
            <Select value={siteId} onValueChange={setSiteId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">{t.devices.siteNone}</SelectItem>
                {(sites.data ?? []).map((s) => (
                  <SelectItem key={s.id} value={String(s.id)}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label>{t.devices.connection}</Label>
            <Tabs value={conn} onValueChange={(v) => setConn(v as "bus" | "tcp")}>
              <TabsList className="w-full">
                <TabsTrigger value="bus" className="flex-1">{t.devices.viaGateway}</TabsTrigger>
                <TabsTrigger value="tcp" className="flex-1">{t.devices.directTcp}</TabsTrigger>
              </TabsList>
            </Tabs>
            <p className="text-xs text-slate-500">{conn === "tcp" ? t.devices.tcpNote : t.devices.busNote}</p>
          </div>

          {conn === "bus" ? (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>{t.meters.gateway}</Label>
                <Select value={gatewayId} onValueChange={setGatewayId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {busGateways.map((g) => (
                      <SelectItem key={g.id} value={String(g.id)}>
                        {g.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label>{t.meters.modbusAddress}</Label>
                <Input value={address} onChange={(e) => setAddress(e.target.value)} type="number" min={1} max={247} />
              </div>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>{t.devices.host}</Label>
                <Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="192.168.1.50" />
              </div>
              <div className="space-y-1.5">
                <Label>{t.devices.port}</Label>
                <Input value={port} onChange={(e) => setPort(e.target.value)} type="number" />
              </div>
              <div className="space-y-1.5">
                <Label>{t.devices.unitId}</Label>
                <Input value={unitId} onChange={(e) => setUnitId(e.target.value)} type="number" min={0} max={255} />
              </div>
              <div className="space-y-1.5">
                <Label>{t.devices.pollInterval}</Label>
                <Input value={interval} onChange={(e) => setIntervalSec(e.target.value)} type="number" min={5} />
              </div>
            </div>
          )}

          {isTcpProfile && conn === "bus" && (
            <p className="text-xs text-amber-600">
              {profile?.brand} {profile?.label} — {t.devices.directTcp} ✓
            </p>
          )}

          <div className="space-y-2">
            <Button
              variant="outline"
              className="w-full"
              disabled={!valid || test.isPending}
              onClick={runTest}
            >
              {test.isPending ? "…" : t.devices.testConnection}
            </Button>
            {testResult && (
              <div
                className={`rounded-md border p-2.5 text-xs ${
                  testResult.ok ? "border-emerald-200 bg-emerald-50 text-emerald-800" : "border-red-200 bg-red-50 text-red-800"
                }`}
              >
                {testResult.ok ? (
                  <>
                    <span className="font-medium">{t.devices.testOk}</span> ({testResult.ms} ms)
                    {testResult.values && (
                      <div className="mt-1 max-h-24 overflow-auto font-mono">
                        {Object.entries(testResult.values)
                          .slice(0, 12)
                          .map(([k, v]) => `${k} = ${v}`)
                          .join(" · ")}
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <span className="font-medium">{t.devices.testFailed}</span> — {testResult.error}
                  </>
                )}
              </div>
            )}
          </div>

          <Button className="w-full" disabled={!valid || create.isPending} onClick={submit}>
            {t.devices.create}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
