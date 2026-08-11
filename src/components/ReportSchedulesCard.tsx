// v9.1/B4: scheduled reports card on the Reports page — daily/weekly/monthly
// xlsx/pdf energy reports delivered by email, with runNow (current period to
// date) as the built-in test path. Mutations are operator+.
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { CalendarClock, Loader2, Play, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

export function ReportSchedulesCard() {
  const { t } = useI18n();
  const me = trpc.auth.me.useQuery();
  const canWrite = me.data?.user?.role === "admin" || me.data?.user?.role === "operator";
  const utils = trpc.useUtils();
  const schedules = trpc.reports.schedules.list.useQuery();
  const sites = trpc.sites.list.useQuery();

  const [name, setName] = useState("");
  const [siteId, setSiteId] = useState<string>("all");
  const [frequency, setFrequency] = useState<"daily" | "weekly" | "monthly">("daily");
  const [format, setFormat] = useState<"xlsx" | "pdf">("xlsx");
  const [hourLocal, setHourLocal] = useState("7");
  const [recipients, setRecipients] = useState("");

  const invalidate = () => void utils.reports.schedules.list.invalidate();
  const create = trpc.reports.schedules.create.useMutation({
    onSuccess: () => {
      invalidate();
      setName(""); setRecipients("");
      toast.success(t.reportSched.created);
    },
    onError: (e) => toast.error(e.message),
  });
  const update = trpc.reports.schedules.update.useMutation({ onSuccess: invalidate, onError: (e) => toast.error(e.message) });
  const remove = trpc.reports.schedules.remove.useMutation({
    onSuccess: () => {
      invalidate();
      toast.success(t.reportSched.removed);
    },
    onError: (e) => toast.error(e.message),
  });
  const runNow = trpc.reports.schedules.runNow.useMutation({
    onSuccess: (r) => toast.success(t.reportSched.ranOk.replace("{file}", (r as { fileName?: string })?.fileName ?? "")),
    onError: (e) => toast.error(e.message),
  });

  const submit = () => {
    const emails = recipients.split(/[,\s]+/).filter((s) => s.includes("@"));
    const hour = Number(hourLocal);
    if (!name.trim() || emails.length === 0 || !Number.isInteger(hour) || hour < 0 || hour > 23) {
      toast.error(t.reportSched.invalid);
      return;
    }
    create.mutate({
      name: name.trim(),
      siteId: siteId === "all" ? null : Number(siteId),
      frequency,
      format,
      recipients: emails,
      hourLocal: hour,
      enabled: true,
    });
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarClock className="h-4 w-4" /> {t.reportSched.title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {canWrite && (
          <div className="flex flex-wrap items-center gap-2">
            <Input className="max-w-44" placeholder={t.reportSched.namePlaceholder} value={name} onChange={(e) => setName(e.target.value)} />
            <Select value={siteId} onValueChange={setSiteId}>
              <SelectTrigger className="h-9 w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t.reportSched.allSites}</SelectItem>
                {(sites.data ?? []).map((s) => (
                  <SelectItem key={s.id} value={String(s.id)}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={frequency} onValueChange={(v) => setFrequency(v as typeof frequency)}>
              <SelectTrigger className="h-9 w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="daily">{t.reportSched.daily}</SelectItem>
                <SelectItem value="weekly">{t.reportSched.weekly}</SelectItem>
                <SelectItem value="monthly">{t.reportSched.monthly}</SelectItem>
              </SelectContent>
            </Select>
            <Select value={format} onValueChange={(v) => setFormat(v as typeof format)}>
              <SelectTrigger className="h-9 w-24">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="xlsx">xlsx</SelectItem>
                <SelectItem value="pdf">pdf</SelectItem>
              </SelectContent>
            </Select>
            <Input className="w-20" type="number" min={0} max={23} value={hourLocal} onChange={(e) => setHourLocal(e.target.value)} title={t.reportSched.hour} />
            <Input className="min-w-56 flex-1" placeholder={t.reportSched.recipientsPlaceholder} value={recipients} onChange={(e) => setRecipients(e.target.value)} />
            <Button size="sm" disabled={create.isPending} onClick={submit}>
              {create.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
              {t.common.add}
            </Button>
          </div>
        )}

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.orgs.name}</TableHead>
              <TableHead>{t.common.sites}</TableHead>
              <TableHead>{t.reportSched.freq}</TableHead>
              <TableHead>{t.reportSched.format}</TableHead>
              <TableHead>{t.reportSched.hour}</TableHead>
              <TableHead>{t.reportSched.recipients}</TableHead>
              <TableHead>{t.reportSched.lastRun}</TableHead>
              <TableHead>{t.apiKeys.status}</TableHead>
              {canWrite && <TableHead />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {(schedules.data ?? []).map((s) => (
              <TableRow key={s.id} className={s.enabled ? "" : "opacity-50"}>
                <TableCell>{s.name}</TableCell>
                <TableCell className="text-xs">{s.siteId ?? t.reportSched.allSites}</TableCell>
                <TableCell>{s.frequency}</TableCell>
                <TableCell>{s.format}</TableCell>
                <TableCell>{String(s.hourLocal).padStart(2, "0")}:00</TableCell>
                <TableCell className="text-xs">{Array.isArray(s.recipients) ? (s.recipients as string[]).join(", ") : "—"}</TableCell>
                <TableCell className="text-xs text-slate-500">{s.lastRunAt ? new Date(s.lastRunAt).toLocaleString() : "—"}</TableCell>
                <TableCell>
                  {canWrite ? (
                    <Button size="sm" variant="ghost" disabled={update.isPending} onClick={() => update.mutate({ id: s.id, patch: { enabled: !s.enabled } })}>
                      {s.enabled ? t.notif.enabled : t.notif.disabled}
                    </Button>
                  ) : s.enabled ? t.notif.enabled : t.notif.disabled}
                </TableCell>
                {canWrite && (
                  <TableCell className="text-right">
                    <Button size="sm" variant="ghost" title={t.reportSched.runNow} disabled={runNow.isPending} onClick={() => runNow.mutate({ id: s.id })}>
                      <Play className="h-3 w-3 text-emerald-600" />
                    </Button>
                    <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate({ id: s.id })}>
                      <Trash2 className="h-3 w-3 text-red-500" />
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
            {(schedules.data ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={9} className="text-center text-sm text-slate-400">
                  {t.reportSched.empty}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
