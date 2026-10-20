// §9.3: tariffs and the tariff-aware planner.
//
// The EMS could discharge on a schedule and shave a peak. Neither knows what
// electricity costs, so the thing a battery is actually bought for on a
// commercial site — buy cheap, use dear — had to be approximated by a human
// writing time windows by hand and editing them whenever the contract changed.
//
// Two things on this screen are deliberate. The optimiser is OFF by default,
// because a planner that starts commanding a battery because somebody filled
// in a price table is not a planner anybody asked for. And the preview comes
// from the same function that writes the real plan, so what an operator
// approves is what will run.
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Loader2, Plus, Receipt } from "lucide-react";
import { toast } from "sonner";

const ALL_SITES = "all";

function hhmmToMin(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}
function minToHhmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

export function TariffCard() {
  const { t } = useI18n();
  const me = trpc.auth.me.useQuery();
  const canWrite = me.data?.user?.role === "admin" || me.data?.user?.role === "operator";
  const utils = trpc.useUtils();
  const tariffs = trpc.ems.tariffs.list.useQuery();
  const sites = trpc.sites.list.useQuery();
  const econ = trpc.ems.economics.list.useQuery();

  const [name, setName] = useState("");
  const [siteId, setSiteId] = useState(ALL_SITES);
  const [currency, setCurrency] = useState("EUR");
  const [tz, setTz] = useState(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  });

  const [periodFor, setPeriodFor] = useState<number | null>(null);
  const [pLabel, setPLabel] = useState("");
  const [pFrom, setPFrom] = useState("17:00");
  const [pTo, setPTo] = useState("21:00");
  const [pImport, setPImport] = useState("0.25");
  const [pExport, setPExport] = useState("");

  const [previewFor, setPreviewFor] = useState<number | null>(null);
  const preview = trpc.ems.economics.preview.useQuery(
    { meterId: previewFor ?? 0 },
    { enabled: previewFor !== null },
  );

  const invalidate = () => {
    void utils.ems.tariffs.list.invalidate();
    void utils.ems.economics.list.invalidate();
  };
  const create = trpc.ems.tariffs.create.useMutation({
    onSuccess: () => {
      invalidate();
      setName("");
      toast.success(t.tariff.created);
    },
    onError: (e) => toast.error(e.message),
  });
  const remove = trpc.ems.tariffs.remove.useMutation({
    onSuccess: () => {
      invalidate();
      toast.success(t.tariff.removed);
    },
    onError: (e) => toast.error(e.message),
  });
  const addPeriod = trpc.ems.tariffs.addPeriod.useMutation({
    onSuccess: () => {
      invalidate();
      toast.success(t.tariff.periodAdded);
    },
    onError: (e) => toast.error(e.message),
  });
  const removePeriod = trpc.ems.tariffs.removePeriod.useMutation({ onSuccess: invalidate, onError: (e) => toast.error(e.message) });
  const setEcon = trpc.ems.economics.set.useMutation({
    onSuccess: () => {
      invalidate();
      toast.success(t.tariff.econSaved);
    },
    onError: (e) => toast.error(e.message),
  });

  const rows = tariffs.data ?? [];
  const econRows = econ.data ?? [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Receipt className="h-4 w-4" /> {t.tariff.title}
          </CardTitle>
          <CardDescription>{t.tariff.hint}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {canWrite && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <div className="space-y-1.5">
                <Label htmlFor="tariff-name">{t.tariff.name}</Label>
                <Input id="tariff-name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label>{t.tariff.site}</Label>
                <Select value={siteId} onValueChange={setSiteId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL_SITES}>{t.tariff.allSites}</SelectItem>
                    {(sites.data ?? []).map((s) => (
                      <SelectItem key={s.id} value={String(s.id)}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tariff-currency">{t.tariff.currency}</Label>
                <Input id="tariff-currency" value={currency} onChange={(e) => setCurrency(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="tariff-tz" title={t.tariff.timezoneHint}>
                  {t.tariff.timezone}
                </Label>
                <Input id="tariff-tz" value={tz} onChange={(e) => setTz(e.target.value)} />
              </div>
              <div className="flex items-end">
                <Button
                  className="w-full"
                  disabled={!name.trim() || create.isPending}
                  onClick={() =>
                    create.mutate({
                      name: name.trim(),
                      siteId: siteId === ALL_SITES ? null : Number(siteId),
                      currency: currency.trim() || "EUR",
                      timezone: tz.trim() || "UTC",
                    })
                  }
                >
                  {create.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Plus className="mr-1 h-4 w-4" />}
                  {t.common.add}
                </Button>
              </div>
            </div>
          )}

          {rows.length === 0 && <p className="text-sm text-muted-foreground">{t.tariff.empty}</p>}

          {rows.map((tr) => (
            <div key={tr.id} className="space-y-2 rounded-md border border-border p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{tr.name}</span>
                <span className="text-xs text-muted-foreground">
                  {tr.siteName ?? t.tariff.allSites} · {tr.currency} · {tr.timezone}
                </span>
                <span className="flex-1" />
                {canWrite && (
                  <>
                    <Button size="sm" variant="outline" onClick={() => setPeriodFor((c) => (c === tr.id ? null : tr.id))}>
                      <Plus className="mr-1 h-3 w-3" />
                      {t.tariff.addPeriod}
                    </Button>
                    <ConfirmButton
                      title={t.tariff.removeTitle}
                      description={t.tariff.removeHint}
                      onConfirm={() => remove.mutate({ id: tr.id })}
                    />
                  </>
                )}
              </div>

              {periodFor === tr.id && canWrite && (
                <div className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
                  <Input placeholder={t.tariff.label} value={pLabel} onChange={(e) => setPLabel(e.target.value)} />
                  <Input type="time" value={pFrom} onChange={(e) => setPFrom(e.target.value)} />
                  <Input type="time" value={pTo} onChange={(e) => setPTo(e.target.value)} />
                  <Input placeholder={t.tariff.importPrice} value={pImport} onChange={(e) => setPImport(e.target.value)} />
                  <Input
                    placeholder={t.tariff.exportUnpaid}
                    value={pExport}
                    onChange={(e) => setPExport(e.target.value)}
                  />
                  <Button
                    disabled={!Number.isFinite(Number(pImport)) || addPeriod.isPending}
                    onClick={() =>
                      addPeriod.mutate({
                        tariffId: tr.id,
                        ...(pLabel.trim() ? { label: pLabel.trim() } : {}),
                        startMin: hhmmToMin(pFrom),
                        endMin: hhmmToMin(pTo),
                        importPrice: Number(pImport),
                        // Blank means "export is not paid", which the
                        // optimiser treats differently from a price of zero.
                        exportPrice: pExport.trim() === "" ? null : Number(pExport),
                      })
                    }
                  >
                    {t.common.add}
                  </Button>
                </div>
              )}

              {tr.periods.length === 0 ? (
                <p className="text-xs text-muted-foreground">{t.tariff.noPeriods}</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t.tariff.label}</TableHead>
                      <TableHead>{t.ems.days}</TableHead>
                      <TableHead>{t.tariff.from}</TableHead>
                      <TableHead>{t.tariff.to}</TableHead>
                      <TableHead>{t.tariff.importPrice}</TableHead>
                      <TableHead>{t.tariff.exportPrice}</TableHead>
                      {canWrite && <TableHead className="text-right">{t.common.actions}</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {tr.periods.map((p) => (
                      <TableRow key={p.id}>
                        <TableCell className="text-sm">{p.label ?? "—"}</TableCell>
                        <TableCell className="text-xs text-muted-foreground">
                          {t.ems.dayLabels.filter((_, d) => (p.dayOfWeekMask >> d) & 1).join(" ")}
                        </TableCell>
                        <TableCell className="text-sm">{minToHhmm(p.startMin)}</TableCell>
                        <TableCell className="text-sm">{minToHhmm(p.endMin)}</TableCell>
                        <TableCell className="text-sm">{p.importPrice}</TableCell>
                        <TableCell className="text-sm text-muted-foreground">
                          {p.exportPrice === null ? t.tariff.exportUnpaid : p.exportPrice}
                        </TableCell>
                        {canWrite && (
                          <TableCell className="text-right">
                            <ConfirmButton
                              title={t.tariff.removeTitle}
                              description={t.tariff.removeHint}
                              onConfirm={() => removePeriod.mutate({ id: p.id })}
                            />
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </div>
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t.tariff.econTitle}</CardTitle>
          <CardDescription>{t.tariff.econHint}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {econRows.length === 0 && <p className="text-sm text-muted-foreground">{t.tariff.econEmpty}</p>}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.soh.device}</TableHead>
                <TableHead>{t.tariff.maxPowerKw}</TableHead>
                <TableHead>{t.tariff.efficiency}</TableHead>
                <TableHead>{t.tariff.minSoc}</TableHead>
                <TableHead>{t.tariff.maxSoc}</TableHead>
                <TableHead title={t.tariff.cycleCostHint}>{t.tariff.cycleCost}</TableHead>
                <TableHead>{t.tariff.optimizerEnabled}</TableHead>
                <TableHead className="text-right">{t.common.actions}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {econRows.map((e) => (
                <EconRow
                  key={e.meterId}
                  row={e}
                  canWrite={canWrite}
                  saving={setEcon.isPending}
                  onSave={(patch) => setEcon.mutate(patch)}
                  onPreview={() => setPreviewFor((c) => (c === e.meterId ? null : e.meterId))}
                />
              ))}
            </TableBody>
          </Table>

          {previewFor !== null && (
            <div className="space-y-2 rounded-md border border-border p-3">
              <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                {t.tariff.previewTitle}
              </h3>
              {preview.isLoading && <Loader2 className="h-4 w-4 animate-spin" />}
              {preview.data && (
                <>
                  {preview.data.plan === null || preview.data.plan.setpoints.length === 0 ? (
                    <p className="text-sm text-muted-foreground">
                      {t.tariff.noPlan} — {preview.data.skipped ?? ""}
                    </p>
                  ) : (
                    <>
                      <p className="text-sm">
                        {t.tariff.grossMargin} {preview.data.plan.grossMargin.toFixed(2)} ·{" "}
                        {t.tariff.wearCost} {preview.data.plan.wearCost.toFixed(2)} ·{" "}
                        <span className="font-medium">
                          {t.tariff.netMargin} {preview.data.plan.netMargin.toFixed(2)}
                        </span>
                      </p>
                      <Table>
                        <TableHeader>
                          <TableRow>
                            <TableHead>{t.tariff.hour}</TableHead>
                            <TableHead>{t.tariff.setpoint}</TableHead>
                          </TableRow>
                        </TableHeader>
                        <TableBody>
                          {preview.data.plan.setpoints.map((s) => (
                            <TableRow key={s.ts}>
                              <TableCell className="whitespace-nowrap text-sm">
                                {new Date(s.ts).toLocaleString()}
                              </TableCell>
                              <TableCell className="text-sm">
                                {s.kw < 0 ? t.tariff.charge : t.tariff.discharge} {Math.abs(s.kw)}
                              </TableCell>
                            </TableRow>
                          ))}
                        </TableBody>
                      </Table>
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

interface EconRowProps {
  row: {
    meterId: number;
    meterName: string;
    maxPowerKw: number;
    roundTripEfficiency: number;
    minSocPct: number;
    maxSocPct: number;
    cycleCost: number;
    optimizerEnabled: boolean;
  };
  canWrite: boolean;
  saving: boolean;
  onSave: (patch: {
    meterId: number;
    maxPowerKw: number;
    roundTripEfficiency: number;
    minSocPct: number;
    maxSocPct: number;
    cycleCost: number;
    optimizerEnabled: boolean;
  }) => void;
  onPreview: () => void;
}

function EconRow({ row, canWrite, saving, onSave, onPreview }: EconRowProps) {
  const { t } = useI18n();
  const [kw, setKw] = useState(String(row.maxPowerKw));
  const [eff, setEff] = useState(String(row.roundTripEfficiency));
  const [minSoc, setMinSoc] = useState(String(row.minSocPct));
  const [maxSoc, setMaxSoc] = useState(String(row.maxSocPct));
  const [cost, setCost] = useState(String(row.cycleCost));
  const [on, setOn] = useState(row.optimizerEnabled);

  const nums = [kw, eff, minSoc, maxSoc, cost].map(Number);
  const valid = nums.every((n) => Number.isFinite(n)) && nums[0] > 0 && nums[3] > nums[2];

  return (
    <TableRow>
      <TableCell className="font-medium">{row.meterName}</TableCell>
      <TableCell>
        <Input className="h-8 w-20" value={kw} disabled={!canWrite} onChange={(e) => setKw(e.target.value)} />
      </TableCell>
      <TableCell>
        <Input className="h-8 w-20" value={eff} disabled={!canWrite} onChange={(e) => setEff(e.target.value)} />
      </TableCell>
      <TableCell>
        <Input className="h-8 w-16" value={minSoc} disabled={!canWrite} onChange={(e) => setMinSoc(e.target.value)} />
      </TableCell>
      <TableCell>
        <Input className="h-8 w-16" value={maxSoc} disabled={!canWrite} onChange={(e) => setMaxSoc(e.target.value)} />
      </TableCell>
      <TableCell>
        <Input className="h-8 w-24" value={cost} disabled={!canWrite} onChange={(e) => setCost(e.target.value)} />
      </TableCell>
      <TableCell>
        {/* Off by default, and it stays off until somebody says otherwise. */}
        <Checkbox checked={on} disabled={!canWrite} onCheckedChange={() => setOn((v) => !v)} />
      </TableCell>
      <TableCell className="space-x-1 text-right">
        <Button size="sm" variant="outline" onClick={onPreview}>
          {t.tariff.preview}
        </Button>
        {canWrite && (
          <Button
            size="sm"
            disabled={!valid || saving}
            onClick={() =>
              onSave({
                meterId: row.meterId,
                maxPowerKw: Number(kw),
                roundTripEfficiency: Number(eff),
                minSocPct: Number(minSoc),
                maxSocPct: Number(maxSoc),
                cycleCost: Number(cost),
                optimizerEnabled: on,
              })
            }
          >
            {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : t.common.save}
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}
