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
import { Save, Download } from "lucide-react";
import { toast } from "sonner";
import { DeviceTypeBadge } from "@/components/shared";
import { ProfileImportDialog } from "@/components/ProfileImportDialog";
import { ProfileVerifyWizard } from "@/components/ProfileVerifyWizard";
import { OrganizationsCard } from "@/components/OrganizationsCard";
import { ApiKeysCard } from "@/components/ApiKeysCard";
import { MfaCard } from "@/components/MfaCard";
import { NotificationChannelsCard } from "@/components/NotificationChannelsCard";
import type { RegisterDef } from "@contracts/modbus";

// Wave 5 / T3: shape of the writable whitelist JSON (mirrors ControllableMap
// in api/control/execute.ts — kept local to avoid importing server code).
type ProfileVerifyWizardControllable = Record<
  string,
  { address: number; fc?: 6 | 16; min: number; max: number; scale?: number; unit?: string; description?: string }
>;

export default function Settings() {
  const { t } = useI18n();
  const profiles = trpc.profiles.list.useQuery();

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t.settings.title}</h1>
          <p className="max-w-3xl text-sm text-slate-500">{t.settings.profilesHint}</p>
        </div>
        {/* Wave 5 / T2: adding a vendor profile is data entry, not a code change */}
        <ProfileImportDialog />
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
          verificationStatus={p.verificationStatus}
          allowUnverifiedControl={p.allowUnverifiedControl}
          dischargePositive={p.dischargePositive}
          controllable={p.controllable as ProfileVerifyWizardControllable | null}
          initialMap={p.registerMap as RegisterDef[]}
        />
      ))}
    </div>
  );
}

// Wave 5 / T1: verification status badge — draft profiles block control writes.
function VerificationBadge({ status }: { status: "draft" | "bench_verified" | "field_verified" }) {
  const { t } = useI18n();
  const styles =
    status === "field_verified"
      ? "bg-emerald-100 text-emerald-700"
      : status === "bench_verified"
        ? "bg-sky-100 text-sky-700"
        : "bg-amber-100 text-amber-700";
  const label =
    status === "field_verified"
      ? t.settings.verificationField
      : status === "bench_verified"
        ? t.settings.verificationBench
        : t.settings.verificationUnverified;
  return <span className={"rounded-full px-2 py-0.5 text-[10px] font-medium " + styles}>{label}</span>;
}

function ProfileCard({
  id,
  model,
  label,
  brand,
  deviceType,
  protocol,
  source,
  verificationStatus,
  allowUnverifiedControl,
  dischargePositive,
  controllable,
  initialMap,
}: {
  id: number;
  model: string;
  label: string;
  brand: string | null;
  deviceType: string;
  protocol: string;
  source: string;
  verificationStatus: "draft" | "bench_verified" | "field_verified";
  allowUnverifiedControl: boolean;
  dischargePositive: boolean | null;
  controllable: ProfileVerifyWizardControllable | null;
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

  // Wave 5 / T2: export the profile back to the canonical CSV (share between
  // installations, diff after a vendor firmware revision).
  const exportCsv = trpc.profiles.exportCsv.useMutation({
    onSuccess: (res) => {
      const url = URL.createObjectURL(new Blob([res.csv], { type: "text/csv" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = res.filename;
      a.click();
      URL.revokeObjectURL(url);
      toast.success(t.settings.csvExported);
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
            <VerificationBadge status={verificationStatus} />
            {allowUnverifiedControl && (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-amber-800">
                ⚠ {t.settings.commissioningOverride}
              </span>
            )}
          </CardTitle>
          <p className="mt-1 text-xs text-slate-500">{label}</p>
        </div>
        <div className="flex gap-2">
          {/* Wave 5 / T3: guided bench verification turns draft → bench_verified */}
          <ProfileVerifyWizard
            id={id}
            model={model}
            label={label}
            verificationStatus={verificationStatus}
            allowUnverifiedControl={allowUnverifiedControl}
            dischargePositive={dischargePositive}
            controllable={controllable}
          />
          <Button variant="outline" size="sm" className="gap-2" disabled={exportCsv.isPending} onClick={() => exportCsv.mutate({ id })}>
            <Download className="h-4 w-4" /> {t.settings.csvExport}
          </Button>
          <Button size="sm" className="gap-2" disabled={save.isPending} onClick={() => save.mutate({ id, registerMap: map })}>
            <Save className="h-4 w-4" /> {t.settings.saveMap}
          </Button>
        </div>
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
