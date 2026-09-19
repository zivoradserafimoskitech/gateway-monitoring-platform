// §9.14: retention and the deletion path (superadmin only).
//
// Retention was one global number, which cannot serve two tenants at once: a
// tenant under a regulator requiring five years of interval data and one who
// wants nothing kept past a month are both reasonable, and one figure has to
// be wrong for one of them.
//
// Deletion is scheduled rather than immediate, and the grace period is the
// point — an irreversible delete of a tenant's entire history executed the
// moment somebody clicks has no way back from a misclick. Cancelling during
// the window is a supported action rather than a database restore, which is
// why the row keeps showing the date and the cancel button until then.
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtTime } from "@/components/shared";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

export function OrgLifecycleCard() {
  const { t } = useI18n();
  const me = trpc.auth.me.useQuery();
  const isSuper = me.data?.user?.isSuperadmin === true;
  const utils = trpc.useUtils();
  const orgs = trpc.orgs.list.useQuery(undefined, { enabled: isSuper });

  const [days, setDays] = useState<Record<number, string>>({});
  const [confirm, setConfirm] = useState<Record<number, string>>({});

  const invalidate = () => void utils.orgs.list.invalidate();
  const setRetention = trpc.orgs.setRetention.useMutation({
    onSuccess: () => {
      invalidate();
      toast.success(t.orgData.retentionSaved);
    },
    onError: (e) => toast.error(e.message),
  });
  const schedule = trpc.orgs.scheduleDeletion.useMutation({
    onSuccess: () => {
      invalidate();
      toast.success(t.orgData.deletionScheduled);
    },
    onError: (e) => toast.error(e.message),
  });
  const cancel = trpc.orgs.cancelDeletion.useMutation({
    onSuccess: () => {
      invalidate();
      toast.success(t.orgData.deletionCancelled);
    },
    onError: (e) => toast.error(e.message),
  });

  if (!isSuper) return null;
  const rows = orgs.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.orgData.retentionTitle}</CardTitle>
        <CardDescription>{t.orgData.retentionHint}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {t.orgData.deletionWarning}
        </p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.common.name}</TableHead>
              <TableHead>{t.orgData.retentionDays}</TableHead>
              <TableHead>{t.orgData.deletionConfirm}</TableHead>
              <TableHead className="text-right">{t.common.actions}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((o) => {
              const pending = o.deletionScheduledFor ?? null;
              const raw = days[o.id] ?? (o.telemetryRawDays === null ? "" : String(o.telemetryRawDays));
              const parsed = raw.trim() === "" ? null : Number(raw);
              const daysValid = parsed === null || (Number.isInteger(parsed) && parsed >= 1 && parsed <= 3650);
              return (
                <TableRow key={o.id}>
                  <TableCell className="font-medium">{o.name}</TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Input
                        className="h-8 w-24"
                        value={raw}
                        placeholder={t.orgData.retentionDefault}
                        onChange={(e) => setDays((d) => ({ ...d, [o.id]: e.target.value }))}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={!daysValid || setRetention.isPending}
                        onClick={() => setRetention.mutate({ orgId: o.id, telemetryRawDays: parsed })}
                      >
                        {setRetention.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : t.common.save}
                      </Button>
                    </div>
                  </TableCell>
                  <TableCell>
                    {pending ? (
                      <span className="text-sm text-red-600">
                        {t.orgData.deletionPending} {fmtTime(pending)}
                      </span>
                    ) : (
                      <Input
                        className="h-8"
                        value={confirm[o.id] ?? ""}
                        placeholder={o.name}
                        onChange={(e) => setConfirm((c) => ({ ...c, [o.id]: e.target.value }))}
                      />
                    )}
                  </TableCell>
                  <TableCell className="text-right">
                    {pending ? (
                      <Button size="sm" variant="outline" disabled={cancel.isPending} onClick={() => cancel.mutate({ orgId: o.id })}>
                        {t.orgData.deletionCancel}
                      </Button>
                    ) : (
                      <Button
                        size="sm"
                        variant="destructive"
                        // Enabled only once the exact name is typed. Not
                        // ceremony: the row above is one misclick away, and
                        // this operation leaves nothing to inspect afterwards.
                        disabled={(confirm[o.id] ?? "") !== o.name || schedule.isPending}
                        onClick={() => schedule.mutate({ orgId: o.id, confirmName: confirm[o.id] ?? "" })}
                      >
                        <Trash2 className="mr-1 h-3 w-3" />
                        {t.orgData.deletionSchedule}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-sm text-muted-foreground">
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
