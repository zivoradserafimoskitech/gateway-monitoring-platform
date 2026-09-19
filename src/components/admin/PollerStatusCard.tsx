// §8: poller.status existed with no screen. The Modbus TCP poller is the half
// of ingestion that nothing else reports on — an MQTT gateway announces
// itself, a polled device is silent by design — so consecutive failures and a
// growing backoff were invisible until the data stopped arriving.
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtTime } from "@/components/shared";
import { cn } from "@/lib/utils";

export function PollerStatusCard() {
  const { t } = useI18n();
  const status = trpc.poller.status.useQuery(undefined, { refetchInterval: 10_000 });
  const devices = status.data?.devices ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span
            className={cn("h-2 w-2 rounded-full", status.data?.running ? "bg-emerald-500" : "bg-muted-foreground")}
          />
          {t.admin.pollerTitle}
        </CardTitle>
        <CardDescription>
          {status.data?.running ? t.admin.pollerRunning : t.admin.pollerStopped}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {devices.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t.admin.pollerNoDevices}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.common.name}</TableHead>
                <TableHead>{t.admin.endpoint}</TableHead>
                <TableHead>{t.admin.interval}</TableHead>
                <TableHead>{t.admin.polls}</TableHead>
                <TableHead>{t.admin.failures}</TableHead>
                <TableHead>{t.admin.lastOk}</TableHead>
                <TableHead>{t.admin.lastError}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {devices.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="font-medium">{d.name}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {d.host}:{d.port}
                    {d.unitId != null ? ` #${d.unitId}` : ""}
                  </TableCell>
                  <TableCell className="text-sm">
                    {d.intervalSec ?? "—"}s
                    {/* A non-zero backoff means the poller has backed off this
                        device after failures — the number operators need when
                        a device "stopped reporting". */}
                    {d.backoffMs > 0 ? (
                      <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-xs text-amber-700">
                        {t.admin.backoff} {Math.round(d.backoffMs / 1000)}s
                      </span>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-sm">{d.polls}</TableCell>
                  <TableCell className={cn("text-sm", d.failures > 0 && "text-red-600")}>{d.failures}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{fmtTime(d.lastOkAt)}</TableCell>
                  <TableCell className="max-w-64 truncate text-xs text-red-600" title={d.lastError ?? ""}>
                    {d.lastError ?? "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
