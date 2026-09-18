// §9.15: the delivery trail.
//
// The queue is the feature, so it has to be visible. "Did our system send it"
// is the first question in every integration argument, and before this the
// only answer available was a line in a server log.
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtTime } from "@/components/shared";
import { Loader2, RotateCcw } from "lucide-react";
import { toast } from "sonner";

export function WebhookDeliveriesCard() {
  const { t } = useI18n();
  const me = trpc.auth.me.useQuery();
  const isAdmin = me.data?.user?.role === "admin";
  const utils = trpc.useUtils();
  const [limit] = useState(50);
  const deliveries = trpc.webhooks.deliveries.useQuery({ limit }, { enabled: isAdmin, refetchInterval: 15_000 });

  const redeliver = trpc.webhooks.redeliver.useMutation({
    onSuccess: () => {
      void utils.webhooks.deliveries.invalidate();
      toast.success(t.webhooks.redelivered);
    },
    onError: (e) => toast.error(e.message),
  });

  if (!isAdmin) return null;
  const rows = deliveries.data ?? [];
  const label = (s: string) =>
    s === "delivered" ? t.webhooks.statusDelivered : s === "dead" ? t.webhooks.statusDead : t.webhooks.statusPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.webhooks.deliveriesTitle}</CardTitle>
        <CardDescription>{t.webhooks.deliveriesHint}</CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.notif.kind}</TableHead>
              <TableHead>{t.common.status}</TableHead>
              <TableHead>{t.webhooks.attempts}</TableHead>
              <TableHead>{t.webhooks.response}</TableHead>
              <TableHead>{t.webhooks.nextAttempt}</TableHead>
              <TableHead>{t.webhooks.lastError}</TableHead>
              <TableHead className="text-right">{t.common.actions}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((d) => (
              <TableRow key={d.id}>
                <TableCell className="font-mono text-xs">{d.event}</TableCell>
                <TableCell>
                  <span
                    className={
                      d.status === "delivered"
                        ? "rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                        : d.status === "dead"
                          ? "rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700 dark:bg-red-950 dark:text-red-300"
                          : "rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                    }
                  >
                    {label(d.status)}
                  </span>
                </TableCell>
                <TableCell className="text-sm">{d.attempts}</TableCell>
                <TableCell className="text-sm">{d.responseStatus ?? "—"}</TableCell>
                <TableCell className="whitespace-nowrap text-xs">
                  {d.status === "pending" ? fmtTime(d.nextAttemptAt) : "—"}
                </TableCell>
                <TableCell className="max-w-64 truncate text-xs text-muted-foreground" title={d.lastError ?? undefined}>
                  {d.lastError ?? "—"}
                </TableCell>
                <TableCell className="text-right">
                  {/* Only a dead delivery: re-queuing one that is still
                      pending would reset its backoff and hammer a receiver
                      that is already being retried on schedule. */}
                  {d.status === "dead" && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={redeliver.isPending}
                      onClick={() => redeliver.mutate({ ids: [d.id] })}
                    >
                      {redeliver.isPending ? (
                        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                      ) : (
                        <RotateCcw className="mr-1 h-3 w-3" />
                      )}
                      {t.webhooks.redeliver}
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-sm text-muted-foreground">
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
