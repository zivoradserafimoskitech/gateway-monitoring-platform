// Wave 8: compact device-profile table — replaces the old ProfileCard dump
// (35 cards × always-expanded register maps = thousands of DOM rows). One row
// per profile; the register-map editor renders lazily inside a single
// expandable row (accordion, one open at a time). Save/Export/Verify reuse
// the exact same tRPC calls as the old ProfileCard.
import { useMemo, useState } from "react";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
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
import { Card, CardContent } from "@/components/ui/card";
import { ChevronDown, ChevronRight, Download, Save, Search } from "lucide-react";
import { toast } from "sonner";
import { DeviceTypeBadge } from "@/components/shared";
import { ProfileVerifyWizard } from "@/components/ProfileVerifyWizard";
import { DEVICE_TYPES } from "@contracts/devices";
import type { RegisterDef } from "@contracts/modbus";

// Wave 5 / T3: shape of the writable whitelist JSON (mirrors ControllableMap
// in api/control/execute.ts — kept local to avoid importing server code).
type ProfileControllable = Record<
  string,
  { address: number; fc?: 6 | 16; min: number; max: number; scale?: number; unit?: string; description?: string }
>;

type VerificationStatus = "draft" | "bench_verified" | "field_verified";

export interface ProfileRowData {
  id: number;
  model: string;
  label: string;
  brand: string | null;
  deviceType: string;
  protocol: string;
  source: string;
  verificationStatus: VerificationStatus;
  allowUnverifiedControl: boolean;
  dischargePositive: boolean | null;
  controllable: unknown;
  registerMap: unknown;
}

// Wave 5 / T1: verification status badge — draft profiles block control
// writes. Shared with any other profile surface (exported per wave-8 spec).
export function VerificationBadge({ status }: { status: VerificationStatus }) {
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

function controllableCount(c: unknown): number {
  if (!c || typeof c !== "object") return 0;
  return Object.keys(c as ProfileControllable).length;
}

export function ProfilesTable({ profiles }: { profiles: ProfileRowData[] }) {
  const { t } = useI18n();
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [verificationFilter, setVerificationFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  // Accordion single mode — at most one register-map editor mounted at a time.
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const summary = useMemo(() => {
    let pv = 0;
    let bess = 0;
    let other = 0;
    let verified = 0;
    let withControl = 0;
    for (const p of profiles) {
      if (p.deviceType === "inverter") pv += 1;
      else if (p.deviceType === "bess") bess += 1;
      else other += 1;
      if (p.verificationStatus !== "draft") verified += 1;
      if (controllableCount(p.controllable) > 0) withControl += 1;
    }
    return { total: profiles.length, pv, bess, other, verified, withControl };
  }, [profiles]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return profiles.filter((p) => {
      if (typeFilter !== "all" && p.deviceType !== typeFilter) return false;
      if (verificationFilter !== "all" && p.verificationStatus !== verificationFilter) return false;
      if (sourceFilter !== "all" && p.source !== sourceFilter) return false;
      if (q) {
        const hay = `${p.model} ${p.brand ?? ""} ${p.label}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [profiles, search, typeFilter, verificationFilter, sourceFilter]);

  const deviceTypeLabels: Record<string, string> = {
    meter: t.devices.meter,
    inverter: t.devices.inverter,
    bess: t.devices.bess,
    weather: t.devices.weather,
  };

  const showingOf = t.settings.showingOf
    .replace("{x}", String(filtered.length))
    .replace("{y}", String(profiles.length));

  const chip = "rounded-full bg-slate-100 px-2.5 py-0.5 text-xs font-medium text-slate-600";

  return (
    <div className="space-y-3">
      {/* Summary chips — fleet overview at a glance */}
      <div className="flex flex-wrap items-center gap-2">
        <span className={chip}>
          {t.settings.summaryTotal}: {summary.total}
        </span>
        <span className={chip}>
          {t.settings.summaryPv}: {summary.pv}
        </span>
        <span className={chip}>
          {t.settings.summaryBess}: {summary.bess}
        </span>
        <span className={chip}>
          {t.settings.summaryOther}: {summary.other}
        </span>
        <span className="rounded-full bg-emerald-100 px-2.5 py-0.5 text-xs font-medium text-emerald-700">
          {t.settings.summaryVerified}: {summary.verified}
        </span>
        <span className="rounded-full bg-violet-100 px-2.5 py-0.5 text-xs font-medium text-violet-700">
          {t.settings.summaryWithControl}: {summary.withControl}
        </span>
      </div>

      {/* Search + filters (client-side) */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-56 flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder={t.settings.searchPlaceholder}
            className="pl-8"
            aria-label={t.settings.searchPlaceholder}
          />
        </div>
        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-40" aria-label={t.settings.filterType}>
            <SelectValue placeholder={t.settings.filterType} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t.settings.allTypes}</SelectItem>
            {DEVICE_TYPES.map((dt) => (
              <SelectItem key={dt} value={dt}>
                {deviceTypeLabels[dt] ?? dt}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={verificationFilter} onValueChange={setVerificationFilter}>
          <SelectTrigger className="w-44" aria-label={t.settings.filterVerification}>
            <SelectValue placeholder={t.settings.filterVerification} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t.settings.allVerification}</SelectItem>
            <SelectItem value="draft">{t.settings.verificationUnverified}</SelectItem>
            <SelectItem value="bench_verified">{t.settings.verificationBench}</SelectItem>
            <SelectItem value="field_verified">{t.settings.verificationField}</SelectItem>
          </SelectContent>
        </Select>
        <Select value={sourceFilter} onValueChange={setSourceFilter}>
          <SelectTrigger className="w-40" aria-label={t.settings.filterSource}>
            <SelectValue placeholder={t.settings.filterSource} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t.settings.allSources}</SelectItem>
            <SelectItem value="vendor">vendor</SelectItem>
            <SelectItem value="community">community</SelectItem>
            <SelectItem value="template">template</SelectItem>
          </SelectContent>
        </Select>
        <span className="text-xs text-slate-500">{showingOf}</span>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.settings.colModel}</TableHead>
                <TableHead>{t.settings.type}</TableHead>
                <TableHead>{t.settings.colProtocol}</TableHead>
                <TableHead>{t.settings.colSource}</TableHead>
                <TableHead>{t.settings.colVerification}</TableHead>
                <TableHead className="w-20 text-right">{t.settings.colRegisters}</TableHead>
                <TableHead className="w-20 text-right">{t.settings.colControl}</TableHead>
                <TableHead className="w-56 text-right">{t.settings.colActions}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((p) => (
                <ProfileTableRow
                  key={p.id}
                  profile={p}
                  expanded={expandedId === p.id}
                  onToggle={() => setExpandedId((cur) => (cur === p.id ? null : p.id))}
                />
              ))}
              {filtered.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="py-8 text-center text-sm text-slate-500">
                    {t.settings.noProfilesMatch}
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

function ProfileTableRow({
  profile: p,
  expanded,
  onToggle,
}: {
  profile: ProfileRowData;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { t } = useI18n();
  const controllable = (p.controllable ?? null) as ProfileControllable | null;
  const registerMap = (p.registerMap ?? []) as RegisterDef[];
  const ctrlCount = controllableCount(p.controllable);

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

  return (
    <>
      <TableRow className={expanded ? "bg-slate-50" : undefined}>
        <TableCell>
          <div className="text-sm font-medium">
            {p.brand ? `${p.brand} ` : ""}
            {p.model}
          </div>
          <div className="text-xs text-slate-500">{p.label}</div>
        </TableCell>
        <TableCell>
          <DeviceTypeBadge type={p.deviceType} />
        </TableCell>
        <TableCell>
          <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium uppercase text-slate-500">
            {p.protocol}
          </span>
        </TableCell>
        <TableCell>
          <span
            className={
              "rounded-full px-2 py-0.5 text-[10px] font-medium " +
              (p.source === "vendor"
                ? "bg-emerald-100 text-emerald-700"
                : p.source === "community"
                  ? "bg-sky-100 text-sky-700"
                  : "bg-slate-200 text-slate-500")
            }
          >
            {p.source}
          </span>
        </TableCell>
        <TableCell>
          <div className="flex flex-wrap items-center gap-1">
            <VerificationBadge status={p.verificationStatus} />
            {p.allowUnverifiedControl && (
              <span
                className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-amber-800"
                title={t.settings.commissioningOverride}
              >
                ⚠
              </span>
            )}
          </div>
        </TableCell>
        <TableCell className="text-right font-mono text-sm">{registerMap.length}</TableCell>
        <TableCell className="text-right font-mono text-sm">
          {ctrlCount > 0 ? ctrlCount : t.settings.controlNone}
        </TableCell>
        <TableCell className="text-right">
          <div className="flex items-center justify-end gap-1">
            {/* Wave 5 / T3: guided bench verification turns draft → bench_verified */}
            <ProfileVerifyWizard
              id={p.id}
              model={p.model}
              label={p.label}
              verificationStatus={p.verificationStatus}
              allowUnverifiedControl={p.allowUnverifiedControl}
              dischargePositive={p.dischargePositive}
              controllable={controllable}
            />
            <Button
              variant="ghost"
              size="sm"
              className="gap-1"
              disabled={exportCsv.isPending}
              onClick={() => exportCsv.mutate({ id: p.id })}
              title={t.settings.csvExport}
            >
              <Download className="h-4 w-4" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={onToggle}
              aria-label={expanded ? t.settings.hideMap : t.settings.showMap}
              title={expanded ? t.settings.hideMap : t.settings.showMap}
            >
              {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
            </Button>
          </div>
        </TableCell>
      </TableRow>
      {expanded && (
        <TableRow>
          <TableCell colSpan={8} className="bg-slate-50 p-4">
            <RegisterMapEditor id={p.id} initialMap={registerMap} />
          </TableCell>
        </TableRow>
      )}
    </>
  );
}

// The register-map editor — the old ProfileCard body (same patch logic, same
// profiles.updateMap call) mounted ONLY while its row is expanded.
function RegisterMapEditor({ id, initialMap }: { id: number; initialMap: RegisterDef[] }) {
  const { t } = useI18n();
  const utils = trpc.useUtils();
  const [map, setMap] = useState<RegisterDef[]>(initialMap);
  // Reset the draft when a different profile's map arrives. React's documented
  // way to do this is to adjust state during render, not in an effect: an
  // effect renders the stale map first and then immediately re-renders.
  const [syncedMap, setSyncedMap] = useState<RegisterDef[]>(initialMap);
  if (initialMap !== syncedMap) {
    setSyncedMap(initialMap);
    setMap(initialMap);
  }

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
    <div className="space-y-3">
      <div className="flex justify-end">
        <Button
          size="sm"
          className="gap-2"
          disabled={save.isPending}
          onClick={() => save.mutate({ id, registerMap: map })}
        >
          <Save className="h-4 w-4" /> {t.settings.saveMap}
        </Button>
      </div>
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
    </div>
  );
}
