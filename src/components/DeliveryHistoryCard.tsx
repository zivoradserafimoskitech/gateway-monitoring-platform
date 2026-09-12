// §8: notifications.deliveries had no screen. "Did the alarm actually reach
// anyone?" is the first question after an incident, and the answer — including
// the failure reason for a channel that rejected the message — was only in the
// database.
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtTime } from "@/components/shared";
import { Link } from "react-router";

export function DeliveryHistoryCard() {
  const { t } = useI18n();
  const [limit, setLimit] = useState("50");
  const deliveries = trpc.notifications.deliveries.useQuery({ limit: Number(limit) });
  const channels = trpc.notifications.channels.useQuery();
  const channelName = (id: number) => channels.data?.find((c) => c.id === id)?.name ?? `#${id}`;

  const kindLabel: Record<string, string> = {
    initial: t.notif.kindInitial,
    escalation: t.notif.kindEscalation,
    resolved: t.notif.kindResolved,
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.notif.deliveriesTitle}</CardTitle>
        <CardDescription>{t.notif.deliveriesHint}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Select value={limit} onValueChange={setLimit}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {["25", "50", "100", "200"].map((n) => (
              <SelectItem key={n} value={n}>
                {n} {t.admin.rows}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.admin.when}</TableHead>
              <TableHead>{t.notif.channel}</TableHead>
              <TableHead>{t.notif.kind}</TableHead>
              <TableHead>{t.common.status}</TableHead>
              <TableHead>{t.notif.alarm}</TableHead>
              <TableHead>{t.common.error}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(deliveries.data ?? []).map((d) => (
              <TableRow key={d.id}>
                <TableCell className="whitespace-nowrap text-sm text-slate-500">{fmtTime(d.createdAt)}</TableCell>
                <TableCell className="text-sm">{channelName(d.channelId)}</TableCell>
                <TableCell className="text-sm">{kindLabel[d.kind] ?? d.kind}</TableCell>
                <TableCell>
                  <span
                    className={
                      d.status === "sent"
                        ? "rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700"
                        : "rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700"
                    }
                  >
                    {d.status === "sent" ? t.notif.statusSent : t.notif.statusFailed}
                  </span>
                </TableCell>
                <TableCell className="text-sm">
                  <Link className="text-emerald-700 hover:underline" to="/alarms">
                    #{d.alarmId}
                  </Link>
                </TableCell>
                <TableCell className="max-w-64 truncate text-xs text-red-600" title={d.error ?? ""}>
                  {d.error ?? "—"}
                </TableCell>
              </TableRow>
            ))}
            {(deliveries.data ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-sm text-slate-500">
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
