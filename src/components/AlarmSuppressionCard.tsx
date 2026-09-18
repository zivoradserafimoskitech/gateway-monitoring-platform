// §9.8: targeted alarm suppression.
//
// Maintenance windows already silence a whole site for a period, which is the
// right tool for planned work and the wrong one for the case that actually
// comes up: one rule, or one device, is known to be misbehaving and should
// stop paging people while somebody fixes it — without going dark on
// everything else at that site.
//
// The reason field is required here as it is in the API. A suppression nobody
// can explain is how an installation ends up permanently quiet.
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { useNow } from "@/hooks/use-now";
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

type Scope = "rule" | "meter" | "site";

function toDate(v: string): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function AlarmSuppressionCard() {
  const { t } = useI18n();
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const canWrite = !me.data?.authRequired || me.data?.user?.role === "admin" || me.data?.user?.role === "operator";

  const rows = trpc.notifications.suppressions.useQuery();
  const rules = trpc.alarms.listRules.useQuery();
  const meters = trpc.meters.list.useQuery();
  const sites = trpc.sites.list.useQuery();

  const [scope, setScope] = useState<Scope>("meter");
  const [refId, setRefId] = useState("");
  const [startsAt, setStartsAt] = useState("");
  const [endsAt, setEndsAt] = useState("");
  const [reason, setReason] = useState("");

  const invalidate = () => void utils.notifications.suppressions.invalidate();
  const create = trpc.notifications.createSuppression.useMutation({
    onSuccess: () => {
      invalidate();
      setRefId("");
      setStartsAt("");
      setEndsAt("");
      setReason("");
      toast.success(t.notif.suppCreated);
    },
    onError: (e) => toast.error(e.message),
  });
  const remove = trpc.notifications.removeSuppression.useMutation({
    onSuccess: invalidate,
    onError: (e) => toast.error(e.message),
  });

  const start = toDate(startsAt);
  const end = toDate(endsAt);
  const rangeOk = start !== null && end !== null && end > start;
  const reasonOk = reason.trim().length > 0;
  const valid = rangeOk && reasonOk && refId !== "";
  const now = useNow();

  const scopeLabel: Record<Scope, string> = {
    rule: t.notif.suppScopeRule,
    meter: t.notif.suppScopeMeter,
    site: t.notif.suppScopeSite,
  };

  const options =
    scope === "rule"
      ? (rules.data ?? []).map((r) => ({ id: r.id, name: r.name }))
      : scope === "meter"
        ? (meters.data ?? []).map((m) => ({ id: m.id, name: m.name }))
        : (sites.data ?? []).map((s) => ({ id: s.id, name: s.name }));

  // The list is keyed by scope+id, so a suppression outlives the thing it
  // names only in the display — showing the raw id is better than hiding a row
  // whose target was deleted while it was still in force.
  const targetName = (s: string, id: number): string => {
    const pool: { id: number; name: string }[] =
      s === "rule" ? (rules.data ?? []) : s === "meter" ? (meters.data ?? []) : (sites.data ?? []);
    return pool.find((x) => x.id === id)?.name ?? `#${id}`;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.notif.suppTitle}</CardTitle>
        <CardDescription>{t.notif.suppHint}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {canWrite && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <div className="space-y-1.5">
              <Label>{t.notif.suppScope}</Label>
              <Select
                value={scope}
                onValueChange={(v) => {
                  setScope(v as Scope);
                  setRefId("");
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="rule">{t.notif.suppScopeRule}</SelectItem>
                  <SelectItem value="meter">{t.notif.suppScopeMeter}</SelectItem>
                  <SelectItem value="site">{t.notif.suppScopeSite}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>{t.notif.suppTarget}</Label>
              <Select value={refId} onValueChange={setRefId}>
                <SelectTrigger>
                  <SelectValue placeholder={scopeLabel[scope]} />
                </SelectTrigger>
                <SelectContent>
                  {options.map((o) => (
                    <SelectItem key={o.id} value={String(o.id)}>
                      {o.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="supp-start">{t.notif.maintStart}</Label>
              <Input
                id="supp-start"
                type="datetime-local"
                value={startsAt}
                onChange={(e) => setStartsAt(e.target.value)}
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="supp-end">{t.notif.maintEnd}</Label>
              <Input id="supp-end" type="datetime-local" value={endsAt} onChange={(e) => setEndsAt(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="supp-reason">{t.notif.suppReason}</Label>
              <Input
                id="supp-reason"
                value={reason}
                placeholder={t.notif.suppReasonPlaceholder}
                onChange={(e) => setReason(e.target.value)}
              />
            </div>
            <div className="flex items-end lg:col-start-5">
              <Button
                className="w-full"
                disabled={!valid || create.isPending}
                onClick={() =>
                  create.mutate({
                    scope,
                    refId: Number(refId),
                    startsAt: start!,
                    endsAt: end!,
                    reason: reason.trim(),
                  })
                }
              >
                {create.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Plus className="mr-1 h-4 w-4" />}
                {t.common.add}
              </Button>
            </div>
          </div>
        )}
        {startsAt && endsAt && !rangeOk ? <p className="text-sm text-red-600">{t.notif.maintRangeError}</p> : null}
        {(startsAt || endsAt || refId) && !reasonOk ? (
          <p className="text-sm text-red-600">{t.notif.suppReasonRequired}</p>
        ) : null}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.notif.suppScope}</TableHead>
              <TableHead>{t.notif.suppTarget}</TableHead>
              <TableHead>{t.notif.maintStart}</TableHead>
              <TableHead>{t.notif.maintEnd}</TableHead>
              <TableHead>{t.notif.suppReason}</TableHead>
              <TableHead>{t.common.status}</TableHead>
              {canWrite && <TableHead className="text-right">{t.common.actions}</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {(rows.data ?? []).map((r) => {
              const s = new Date(r.startsAt).getTime();
              const e = new Date(r.endsAt).getTime();
              const live = now >= s && now < e;
              const state = now < s ? t.notif.maintScheduled : live ? t.notif.maintActive : t.notif.maintPast;
              return (
                <TableRow key={r.id}>
                  <TableCell>{scopeLabel[r.scope as Scope]}</TableCell>
                  <TableCell>{targetName(r.scope, r.refId)}</TableCell>
                  <TableCell className="whitespace-nowrap text-sm">{fmtTime(r.startsAt)}</TableCell>
                  <TableCell className="whitespace-nowrap text-sm">{fmtTime(r.endsAt)}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{r.reason}</TableCell>
                  <TableCell>
                    <span
                      className={
                        live
                          ? "rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-700"
                          : "rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                      }
                    >
                      {state}
                    </span>
                  </TableCell>
                  {canWrite && (
                    <TableCell className="text-right">
                      <ConfirmButton
                        title={t.notif.suppRemoveTitle}
                        description={t.notif.suppRemoveHint}
                        onConfirm={() => remove.mutate({ id: r.id })}
                      />
                    </TableCell>
                  )}
                </TableRow>
              );
            })}
            {(rows.data ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={canWrite ? 7 : 6} className="text-sm text-muted-foreground">
                  {t.notif.suppEmpty}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
