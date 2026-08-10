// v8/D3: scheduled-reports card on the Reports page — list with enable toggle,
// delete and "Run now", plus a create form (site / frequency / format /
// recipients / delivery hour). Operator-gated writes like ControlPanel.
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { fmtTime } from "@/components/shared";
import { Loader2, Play, Plus, Trash2 } from "lucide-react";

type Freq = "daily" | "weekly" | "monthly";

export function ReportSchedulesCard() {
  const { t } = useI18n();
  const me = trpc.auth.me.useQuery();
  const canWrite = me.data?.user?.role === "admin" || me.data?.user?.role === "operator";
  const utils = trpc.useUtils();
  const schedules = trpc.reports.schedules.list.useQuery();
  const sites = trpc.sites.list.useQuery();

  const invalidate = () => void utils.reports.schedules.list.invalidate();
  const create = trpc.reports.schedules.create.useMutation({ onSettled: invalidate });
  const update = trpc.reports.schedules.update.useMutation({ onSettled: invalidate });
  const remove = trpc.reports.schedules.remove.useMutation({ onSettled: invalidate });
  const runNow = trpc.reports.schedules.runNow.useMutation({ onSettled: invalidate });

  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState("");
  const [siteId, setSiteId] = useState<string>("all");
  const [frequency, setFrequency] = useState<Freq>("daily");
  const [format, setFormat] = useState<"xlsx" | "pdf">("xlsx");
  const [recipients, setRecipients] = useState("");
  const [hourLocal, setHourLocal] = useState("8");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const freqLabel: Record<Freq, string> = { daily: t.reports.freqDaily, weekly: t.reports.freqWeekly, monthly: t.reports.freqMonthly };
  const siteName = (id: number | null) => (id == null ? t.reports.allSites : (sites.data ?? []).find((s) => s.id === id)?.name ?? `#${id}`);

  const submit = async () => {
    setError(null);
    setNotice(null);
    const emails = recipients.split(",").map((e) => e.trim()).filter(Boolean);
    const hour = Number(hourLocal);
    if (!name.trim() || emails.length === 0 || !emails.every((e) => e.includes("@")) || !Number.isInteger(hour) || hour < 0 || hour > 23) {
      setError(t.reports.invalidSchedule);
      return;
    }
    try {
      await create.mutateAsync({
        siteId: siteId === "all" ? null : Number(siteId),
        name: name.trim(),
        frequency,
        format,
        recipients: emails,
        hourLocal: hour,
      });
      setShowForm(false);
      setName("");
      setRecipients("");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  const run = async (id: number) => {
    setError(null);
    setNotice(null);
    try {
      const res = await runNow.mutateAsync({ id });
      setNotice(`${t.reports.runDone}: ${res.filename ?? res.path} (${res.bytes} B, ${res.transport})`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>{t.reports.schedules}</CardTitle>
        {canWrite && (
          <Button size="sm" variant="outline" onClick={() => setShowForm((v) => !v)}>
            <Plus className="h-3 w-3" /> {t.reports.addSchedule}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3">
        {(schedules.data ?? []).length === 0 && <p className="text-sm text-slate-500">{t.reports.noSchedules}</p>}
        <div className="space-y-1">
          {(schedules.data ?? []).map((s) => (
            <div key={s.id} className="flex flex-wrap items-center gap-2 rounded-md border border-slate-200 p-2 text-sm">
              <span className="min-w-32 font-medium">{s.name}</span>
              <span className="text-xs text-slate-500">
                {siteName(s.siteId)} · {freqLabel[s.frequency as Freq]} · {s.format.toUpperCase()} · {String(s.hourLocal).padStart(2, "0")}:00 · {(s.recipients as string[]).join(", ")}
              </span>
              <span className="text-xs text-slate-400">
                {t.reports.lastRun}: {s.lastRunAt ? fmtTime(s.lastRunAt) : "—"}
              </span>
              <span className="flex-1" />
              {canWrite && (
                <>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={runNow.isPending}
                    onClick={() => void run(s.id)}
                    title={t.reports.runNow}
                  >
                    {runNow.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Play className="h-3 w-3" />}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={update.isPending}
                    onClick={() => void update.mutateAsync({ id: s.id, patch: { enabled: !s.enabled } })}
                  >
                    {s.enabled ? t.ems.enabled : t.ems.disabled}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={remove.isPending}
                    onClick={() => {
                      if (window.confirm(`${t.common.delete}: ${s.name}?`)) void remove.mutateAsync({ id: s.id });
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </>
              )}
            </div>
          ))}
        </div>

        {showForm && canWrite && (
          <div className="space-y-3 rounded-md border border-slate-200 bg-slate-50 p-3">
            <div className="grid items-end gap-3 md:grid-cols-3">
              <div className="space-y-1">
                <Label>{t.reports.scheduleName}</Label>
                <Input value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>{t.common.sites}</Label>
                <Select value={siteId} onValueChange={setSiteId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">{t.reports.allSites}</SelectItem>
                    {(sites.data ?? []).map((s) => (
                      <SelectItem key={s.id} value={String(s.id)}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>{t.reports.frequency}</Label>
                <Select value={frequency} onValueChange={(v) => setFrequency(v as Freq)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {(["daily", "weekly", "monthly"] as Freq[]).map((f) => (
                      <SelectItem key={f} value={f}>
                        {freqLabel[f]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>{t.reports.format}</Label>
                <Select value={format} onValueChange={(v) => setFormat(v as "xlsx" | "pdf")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="xlsx">XLSX</SelectItem>
                    <SelectItem value="pdf">PDF</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label>{t.reports.hourLocal}</Label>
                <Input type="number" min={0} max={23} value={hourLocal} onChange={(e) => setHourLocal(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label>{t.reports.recipients}</Label>
                <Input placeholder={t.reports.recipientsHint} value={recipients} onChange={(e) => setRecipients(e.target.value)} />
              </div>
            </div>
            <Button size="sm" disabled={create.isPending} onClick={() => void submit()}>
              {create.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
              {t.common.add}
            </Button>
          </div>
        )}
        {error && <p className="rounded-md bg-red-50 p-2 text-sm text-red-700">{error}</p>}
        {notice && <p className="rounded-md bg-emerald-50 p-2 text-sm text-emerald-700">{notice}</p>}
        {!canWrite && <p className="text-xs text-slate-500">{t.reports.readonlyRole}</p>}
      </CardContent>
    </Card>
  );
}
