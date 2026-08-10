// v8/D1: EMS automation panel — BESS charge/discharge schedule editor,
// peak-shaving config form, and the recent automatic command feed. Rendered on
// MeterDetail for BESS-type devices (or any device whose model is controllable —
// ControlPanel already covers the manual side). Follows ControlPanel patterns.
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { fmtTime } from "@/components/shared";
import { Loader2, Plus, Trash2 } from "lucide-react";

type Mode = "charge" | "discharge" | "idle";

function hhmmToMin(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}
function minToHhmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

export function EmsPanel({ meterId, deviceType }: { meterId: number; deviceType: string }) {
  const { t } = useI18n();
  const me = trpc.auth.me.useQuery();
  const canWrite = me.data?.user?.role === "admin" || me.data?.user?.role === "operator";
  const utils = trpc.useUtils();

  const schedules = trpc.ems.schedules.list.useQuery({ meterId });
  const peakConfigs = trpc.ems.peakShaving.list.useQuery({ bessMeterId: meterId });
  const autoCommands = trpc.ems.autoCommands.useQuery({ meterId, limit: 10 }, { refetchInterval: 15000 });
  const metersList = trpc.meters.list.useQuery();

  const invalidate = () => {
    void utils.ems.schedules.list.invalidate({ meterId });
    void utils.ems.peakShaving.list.invalidate({ bessMeterId: meterId });
    void utils.ems.autoCommands.invalidate({ meterId });
  };
  const createSchedule = trpc.ems.schedules.create.useMutation({ onSettled: invalidate });
  const updateSchedule = trpc.ems.schedules.update.useMutation({ onSettled: invalidate });
  const removeSchedule = trpc.ems.schedules.remove.useMutation({ onSettled: invalidate });
  const createPeak = trpc.ems.peakShaving.create.useMutation({ onSettled: invalidate });
  const updatePeak = trpc.ems.peakShaving.update.useMutation({ onSettled: invalidate });
  const removePeak = trpc.ems.peakShaving.remove.useMutation({ onSettled: invalidate });

  const [showScheduleForm, setShowScheduleForm] = useState(false);
  const [sName, setSName] = useState("");
  const [sMask, setSMask] = useState(127);
  const [sStart, setSStart] = useState("18:00");
  const [sEnd, setSEnd] = useState("22:00");
  const [sMode, setSMode] = useState<Mode>("discharge");
  const [sTargetKw, setSTargetKw] = useState("");
  const [sTargetSoc, setSTargetSoc] = useState("");
  const [sError, setSError] = useState<string | null>(null);

  const [showPeakForm, setShowPeakForm] = useState(false);
  const [pSource, setPSource] = useState("");
  const [pThreshold, setPThreshold] = useState("");
  const [pHysteresis, setPHysteresis] = useState("0");
  const [pMax, setPMax] = useState("");
  const [pError, setPError] = useState<string | null>(null);

  if (deviceType !== "bess") return null;

  const inputCls = "h-8 rounded-md border border-slate-300 px-2 text-sm disabled:bg-slate-50";

  const submitSchedule = async () => {
    setSError(null);
    if (!sName.trim() || sMask === 0 || !sStart || !sEnd) {
      setSError(t.ems.invalidWindow);
      return;
    }
    try {
      await createSchedule.mutateAsync({
        meterId,
        name: sName.trim(),
        dayOfWeekMask: sMask,
        startMin: hhmmToMin(sStart),
        endMin: hhmmToMin(sEnd),
        mode: sMode,
        targetKw: sTargetKw === "" ? null : Number(sTargetKw),
        targetSoc: sTargetSoc === "" ? null : Number(sTargetSoc),
      });
      setShowScheduleForm(false);
      setSName("");
      setSTargetKw("");
      setSTargetSoc("");
    } catch (err) {
      setSError(err instanceof Error ? err.message : String(err));
    }
  };

  const submitPeak = async () => {
    setPError(null);
    const sourceMeterId = Number(pSource);
    const thresholdKw = Number(pThreshold);
    const maxDischargeKw = Number(pMax);
    if (!sourceMeterId || !Number.isFinite(thresholdKw) || !Number.isFinite(maxDischargeKw) || maxDischargeKw <= 0) {
      setPError(t.ems.invalidWindow);
      return;
    }
    try {
      await createPeak.mutateAsync({
        sourceMeterId,
        bessMeterId: meterId,
        thresholdKw,
        hysteresisKw: Number(pHysteresis) || 0,
        maxDischargeKw,
      });
      setShowPeakForm(false);
      setPSource("");
      setPThreshold("");
      setPMax("");
    } catch (err) {
      setPError(err instanceof Error ? err.message : String(err));
    }
  };

  const toggleDay = (d: number) => setSMask((m) => m ^ (1 << d));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.ems.title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* ── Schedules ── */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">{t.ems.schedules}</h3>
            {canWrite && (
              <Button size="sm" variant="outline" onClick={() => setShowScheduleForm((v) => !v)}>
                <Plus className="h-3 w-3" /> {t.ems.addSchedule}
              </Button>
            )}
          </div>
          {(schedules.data ?? []).length === 0 && <p className="text-xs text-slate-500">{t.ems.noSchedules}</p>}
          <div className="space-y-1">
            {(schedules.data ?? []).map((s) => (
              <div key={s.id} className="flex flex-wrap items-center gap-2 rounded-md border border-slate-200 p-2 text-sm">
                <span className="min-w-28 font-medium">{s.name}</span>
                <span className="text-xs text-slate-500">
                  {t.ems.dayLabels.filter((_, d) => (s.dayOfWeekMask >> d) & 1).join(" ")} · {minToHhmm(s.startMin)}–{minToHhmm(s.endMin)}
                </span>
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs">{t.ems.modes[s.mode]}</span>
                {s.targetKw != null && <span className="text-xs text-slate-500">{s.targetKw} kW</span>}
                {s.targetSoc != null && <span className="text-xs text-slate-500">SOC {s.targetSoc}%</span>}
                <span className="flex-1" />
                {canWrite && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={updateSchedule.isPending}
                      onClick={() => void updateSchedule.mutateAsync({ id: s.id, patch: { enabled: !s.enabled } })}
                    >
                      {s.enabled ? t.ems.enabled : t.ems.disabled}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={removeSchedule.isPending}
                      onClick={() => {
                        if (window.confirm(`${t.common.delete}: ${s.name}?`)) void removeSchedule.mutateAsync({ id: s.id });
                      }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </>
                )}
              </div>
            ))}
          </div>
          {showScheduleForm && canWrite && (
            <div className="mt-2 space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <input className={`${inputCls} w-40`} placeholder={t.ems.name} value={sName} onChange={(e) => setSName(e.target.value)} />
                <select className={inputCls} value={sMode} onChange={(e) => setSMode(e.target.value as Mode)}>
                  {(["charge", "discharge", "idle"] as Mode[]).map((m) => (
                    <option key={m} value={m}>{t.ems.modes[m]}</option>
                  ))}
                </select>
                <input type="time" className={inputCls} value={sStart} onChange={(e) => setSStart(e.target.value)} />
                <span className="text-xs text-slate-400">–</span>
                <input type="time" className={inputCls} value={sEnd} onChange={(e) => setSEnd(e.target.value)} />
                <input type="number" className={`${inputCls} w-28`} placeholder={`${t.ems.targetKw} (${t.ems.optional})`} value={sTargetKw} onChange={(e) => setSTargetKw(e.target.value)} />
                <input type="number" className={`${inputCls} w-28`} placeholder={`${t.ems.targetSoc} (${t.ems.optional})`} value={sTargetSoc} onChange={(e) => setSTargetSoc(e.target.value)} />
              </div>
              <div className="flex flex-wrap items-center gap-1">
                <span className="mr-1 text-xs text-slate-500">{t.ems.days}:</span>
                {t.ems.dayLabels.map((lbl, d) => (
                  <button
                    key={lbl}
                    type="button"
                    onClick={() => toggleDay(d)}
                    className={`rounded px-2 py-1 text-xs ${(sMask >> d) & 1 ? "bg-emerald-600 text-white" : "bg-slate-200 text-slate-600"}`}
                  >
                    {lbl}
                  </button>
                ))}
                <span className="flex-1" />
                <Button size="sm" disabled={createSchedule.isPending} onClick={() => void submitSchedule()}>
                  {createSchedule.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                  {t.common.add}
                </Button>
              </div>
              {sError && <p className="rounded-md bg-red-50 p-2 text-sm text-red-700">{sError}</p>}
            </div>
          )}
        </div>

        {/* ── Peak shaving ── */}
        <div>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-xs font-medium uppercase tracking-wide text-slate-500">{t.ems.peakShaving}</h3>
            {canWrite && (
              <Button size="sm" variant="outline" onClick={() => setShowPeakForm((v) => !v)}>
                <Plus className="h-3 w-3" /> {t.ems.addConfig}
              </Button>
            )}
          </div>
          {(peakConfigs.data ?? []).length === 0 && <p className="text-xs text-slate-500">{t.ems.noConfigs}</p>}
          <div className="space-y-1">
            {(peakConfigs.data ?? []).map((c) => (
              <div key={c.id} className="flex flex-wrap items-center gap-2 rounded-md border border-slate-200 p-2 text-sm">
                <span className="text-xs text-slate-500">
                  {t.ems.sourceMeter} #{c.sourceMeterId} · {t.ems.thresholdKw} {c.thresholdKw} · {t.ems.hysteresisKw} {c.hysteresisKw} · {t.ems.maxDischargeKw} {c.maxDischargeKw}
                </span>
                <span className="flex-1" />
                {canWrite && (
                  <>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={updatePeak.isPending}
                      onClick={() => void updatePeak.mutateAsync({ id: c.id, patch: { enabled: !c.enabled } })}
                    >
                      {c.enabled ? t.ems.enabled : t.ems.disabled}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={removePeak.isPending}
                      onClick={() => {
                        if (window.confirm(`${t.common.delete} #${c.id}?`)) void removePeak.mutateAsync({ id: c.id });
                      }}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </>
                )}
              </div>
            ))}
          </div>
          {showPeakForm && canWrite && (
            <div className="mt-2 space-y-2 rounded-md border border-slate-200 bg-slate-50 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <select className={`${inputCls} w-56`} value={pSource} onChange={(e) => setPSource(e.target.value)}>
                  <option value="">{t.ems.sourceMeter}</option>
                  {(metersList.data ?? [])
                    .filter((m) => m.id !== meterId)
                    .map((m) => (
                      <option key={m.id} value={m.id}>{m.name} (#{m.id})</option>
                    ))}
                </select>
                <input type="number" className={`${inputCls} w-28`} placeholder={t.ems.thresholdKw} value={pThreshold} onChange={(e) => setPThreshold(e.target.value)} />
                <input type="number" className={`${inputCls} w-28`} placeholder={t.ems.hysteresisKw} value={pHysteresis} onChange={(e) => setPHysteresis(e.target.value)} />
                <input type="number" className={`${inputCls} w-32`} placeholder={t.ems.maxDischargeKw} value={pMax} onChange={(e) => setPMax(e.target.value)} />
                <Button size="sm" disabled={createPeak.isPending} onClick={() => void submitPeak()}>
                  {createPeak.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
                  {t.common.add}
                </Button>
              </div>
              {pError && <p className="rounded-md bg-red-50 p-2 text-sm text-red-700">{pError}</p>}
            </div>
          )}
        </div>

        {/* ── Auto commands feed ── */}
        {(autoCommands.data ?? []).length > 0 && (
          <div>
            <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">{t.ems.autoCommands}</h3>
            <div className="space-y-1 text-sm">
              {(autoCommands.data ?? []).map((c) => (
                <div key={c.id} className="flex items-center justify-between border-b border-slate-100 py-1">
                  <span className="font-mono text-xs">
                    {c.controlKey}
                    {c.controlValue !== null && c.controlValue !== undefined ? ` = ${c.controlValue}` : ""}
                    <span className="ml-2 rounded bg-violet-100 px-1.5 py-0.5 font-sans text-violet-700">{t.ems.system}</span>
                  </span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                      c.status === "ok" ? "bg-emerald-100 text-emerald-700" : c.status === "sent" ? "bg-sky-100 text-sky-700" : "bg-red-100 text-red-700"
                    }`}
                  >
                    {c.status}
                  </span>
                  <span className="text-xs text-slate-400">{fmtTime(c.createdAt)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {!canWrite && <p className="text-xs text-slate-500">{t.ems.readonlyRole}</p>}
      </CardContent>
    </Card>
  );
}
