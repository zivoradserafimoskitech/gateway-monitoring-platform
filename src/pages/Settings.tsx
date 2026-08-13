import { useEffect, useState } from "react";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
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
import { Save } from "lucide-react";
import { toast } from "sonner";
import { DeviceTypeBadge } from "@/components/shared";
import { OrganizationsCard } from "@/components/OrganizationsCard";
import { ApiKeysCard } from "@/components/ApiKeysCard";
import { MfaCard } from "@/components/MfaCard";
import { NotificationChannelsCard } from "@/components/NotificationChannelsCard";
import type { RegisterDef } from "@contracts/modbus";

export default function Settings() {
  const { t } = useI18n();
  const profiles = trpc.profiles.list.useQuery();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t.settings.title}</h1>
        <p className="max-w-3xl text-sm text-slate-500">{t.settings.profilesHint}</p>
      </div>
      {/* v8/D2: organizations — superadmin only */}
      <OrganizationsCard />
      {/* v9.1: API keys (admin only) + notification channels */}
      <ApiKeysCard />
      {/* audit #23: per-user TOTP MFA */}
      <MfaCard />
      <NotificationChannelsCard />
      {(profiles.data ?? []).map((p) => (
        <ProfileCard
          key={p.id}
          id={p.id}
          model={p.model}
          label={p.label}
          brand={p.brand}
          deviceType={p.deviceType}
          protocol={p.protocol}
          source={p.source}
          initialMap={p.registerMap as RegisterDef[]}
        />
      ))}
    </div>
  );
}

function ProfileCard({
  id,
  model,
  label,
  brand,
  deviceType,
  protocol,
  source,
  initialMap,
}: {
  id: number;
  model: string;
  label: string;
  brand: string | null;
  deviceType: string;
  protocol: string;
  source: string;
  initialMap: RegisterDef[];
}) {
  const { t } = useI18n();
  const utils = trpc.useUtils();
  const [map, setMap] = useState<RegisterDef[]>(initialMap);
  useEffect(() => setMap(initialMap), [initialMap]);

  const save = trpc.profiles.updateMap.useMutation({
    onSuccess: () => {
      utils.profiles.list.invalidate();
      toast.success(t.settings.mapSaved);
    },
    onError: (e) => toast.error(e.message),
  });

  const patch = (idx: number, partial: Partial<RegisterDef>) => {
    setMap((m) => m.map((r, i) => (i === idx ? { ...r, ...partial } : r)));
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            {brand ? `${brand} ` : ""}
            {model}
            <DeviceTypeBadge type={deviceType} />
            <span
              className={
                "rounded-full px-2 py-0.5 text-[10px] font-medium " +
                (source === "vendor"
                  ? "bg-emerald-100 text-emerald-700"
                  : source === "community"
                    ? "bg-sky-100 text-sky-700"
                    : "bg-slate-200 text-slate-500")
              }
            >
              {source}
            </span>
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium uppercase text-slate-500">
              {protocol}
            </span>
          </CardTitle>
          <p className="mt-1 text-xs text-slate-500">{label}</p>
        </div>
        <Button size="sm" className="gap-2" disabled={save.isPending} onClick={() => save.mutate({ id, registerMap: map })}>
          <Save className="h-4 w-4" /> {t.settings.saveMap}
        </Button>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.settings.field}</TableHead>
              <TableHead className="w-28">{t.settings.register}</TableHead>
              <TableHead className="w-24">{t.settings.functionCode}</TableHead>
              <TableHead className="w-32">{t.settings.type}</TableHead>
              <TableHead className="w-28">{t.settings.scale}</TableHead>
              <TableHead className="w-20">{t.settings.unit}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {map.map((r, i) => (
              <TableRow key={r.key}>
                <TableCell className="text-sm">
                  {r.label} <span className="ml-1 font-mono text-xs text-slate-400">({r.key})</span>
                </TableCell>
                <TableCell>
                  <Input
                    type="number"
                    className="h-8 font-mono"
                    value={r.address}
                    onChange={(e) => patch(i, { address: Number(e.target.value) })}
                  />
                </TableCell>
                <TableCell>
                  <Select
                    value={String(r.functionCode)}
                    onValueChange={(v) => patch(i, { functionCode: Number(v) as 3 | 4 })}
                  >
                    <SelectTrigger className="h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="4">04</SelectItem>
                      <SelectItem value="3">03</SelectItem>
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell>
                  <Select
                    value={r.type}
                    onValueChange={(v) => patch(i, { type: v as RegisterDef["type"] })}
                  >
                    <SelectTrigger className="h-8">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {(["float32", "u32", "i32", "u16", "i16"] as const).map((tp) => (
                        <SelectItem key={tp} value={tp}>
                          {tp}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell>
                  <Input
                    type="number"
                    step="any"
                    className="h-8 font-mono"
                    value={r.scale}
                    onChange={(e) => patch(i, { scale: Number(e.target.value) })}
                  />
                </TableCell>
                <TableCell className="text-sm text-slate-500">{r.unit}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
