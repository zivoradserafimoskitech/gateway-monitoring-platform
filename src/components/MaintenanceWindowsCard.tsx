// §8: notifications.maintenance / createMaintenance / removeMaintenance had no
// screen, so the one mechanism that stops a planned outage from paging the
// whole on-call rota could not be used from the product.
import { useEffect, useState } from "react";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfirmButton } from "@/components/ConfirmButton";
import { fmtTime } from "@/components/shared";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

const ALL_SITES = "all";

/** Current time as state, re-read every minute.
 *
 *  Reading the clock during render is impure — React may render at any moment,
 *  so the "in progress" badge would change on unrelated re-renders and not
 *  change at all while the page sits open. A window that starts in two minutes
 *  should start looking active two minutes later without a refresh. */
function useNow(intervalMs = 60_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** datetime-local value → Date. The input is local time, which is what an
 *  operator scheduling a site visit means. */
function toDate(v: string): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function MaintenanceWindowsCard() {
  const { t } = useI18n();
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const canWrite = !me.data?.authRequired || me.data?.user?.role === "admin" || me.data?.user?.role === "operator";
  const windows = trpc.notifications.maintenance.useQuery();
  const sites = trpc.sites.list.useQuery();

  const [siteId, setSiteId] = useState(ALL_SITES);
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [note, setNote] = useState("");

  const invalidate = () => void utils.notifications.maintenance.invalidate();
  const create = trpc.notifications.createMaintenance.useMutation({
    onSuccess: () => {
      invalidate();
      setStartsAt("");
      setEndsAt("");
      setNote("");
      toast.success(t.notif.maintCreated);
    },
    onError: (e) => toast.error(e.message),
  });
  const remove = trpc.notifications.removeMaintenance.useMutation({
    onSuccess: invalidate,
    onError: (e) => toast.error(e.message),
  });

  const start = toDate(startsAt);
  const end = toDate(endsAt);
  const valid = start !== null && end !== null && end > start;
  const now = useNow();

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.notif.maintTitle}</CardTitle>
        <CardDescription>{t.notif.maintHint}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {canWrite && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div className="space-y-1.5">
              <Label>{t.common.sites}</Label>
              <Select value={siteId} onValueChange={setSiteId}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={ALL_SITES}>{t.notif.maintAllSites}</SelectItem>
                  {(sites.data ?? []).map((s) => (
                    <SelectItem key={s.id} value={String(s.id)}>
                      {s.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="maint-start">{t.notif.maintStart}</Label>
              <Input
                id="maint-start"
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="maint-end">{t.notif.maintEnd}</Label>
              <Input id="maint-end" type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="maint-note">{t.notif.maintNote}</Label>
              <Input id="maint-note" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
            <div className="flex items-end">
              <Button
                className="w-full"
                disabled={!valid || create.isPending}
                onClick={() =>
                  create.mutate({
                    siteId: siteId === ALL_SITES ? null : Number(siteId),
                    startsAt: start!,
                    endsAt: end!,
                    ...(note.trim() ? { note: note.trim() } : {}),
                  })
                }
              >
                {create.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Plus className="mr-1 h-4 w-4" />}
                {t.common.add}
              </Button>
            </div>
          </div>
        )}
        {startsAt && endsAt && !valid ? (
          <p className="text-sm text-red-600">{t.notif.maintRangeError}</p>
        ) : null}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.common.sites}</TableHead>
              <TableHead>{t.notif.maintStart}</TableHead>
              <TableHead>{t.notif.maintEnd}</TableHead>
              <TableHead>{t.notif.maintNote}</TableHead>
              <TableHead>{t.common.status}</TableHead>
              {canWrite && <TableHead className="text-right">{t.common.actions}</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {(windows.data ?? []).map((w) => {
              const s = new Date(w.startsAt).getTime();
              const e = new Date(w.endsAt).getTime();
              const state = now < s ? t.notif.maintScheduled : now <= e ? t.notif.maintActive : t.notif.maintPast;
              return (
                <TableRow key={w.id}>
                  <TableCell>{w.siteName ?? t.notif.maintAllSites}</TableCell>
                  <TableCell className="whitespace-nowrap text-sm">{fmtTime(w.startsAt)}</TableCell>
                  <TableCell className="whitespace-nowrap text-sm">{fmtTime(w.endsAt)}</TableCell>
                  <TableCell className="text-sm text-slate-600">{w.note ?? "—"}</TableCell>
                  <TableCell>
                    <span
                      className={
                        now >= s && now <= e
                          ? "rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700"
                          : "rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-600"
                      }
                    >
                      {state}
                    </span>
                  </TableCell>
                  {canWrite && (
                    <TableCell className="text-right">
                      <ConfirmButton
                        title={t.notif.maintRemoveTitle}
                        description={t.notif.maintRemoveHint}
                        onConfirm={() => remove.mutate({ id: w.id })}
                      />
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
            {(windows.data ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={canWrite ? 6 : 5} className="text-sm text-slate-500">
                  {t.common.noData}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
