// §9.14: per-org data export.
//
// A tenant's data has to be able to leave. The request arrives as a contract
// clause, as a regulator's question, or on the day a customer moves to another
// supplier and is entitled to take their history — and before this the only
// routes out were a scheduled energy report (one metric, emailed) and direct
// database access (everyone's data at once).
//
// Admin rather than superadmin: making it superadmin-only would route every
// "give us our data" request through whoever holds the platform account.
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtTime } from "@/components/shared";
import { Download, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

function fmtBytes(n: number | null): string {
  if (n === null || n === undefined) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function toDate(v: string): Date | null {
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function DataExportCard() {
  const { t } = useI18n();
  const me = trpc.auth.me.useQuery();
  const isAdmin = me.data?.user?.role === "admin";
  const utils = trpc.useUtils();
  // While an export is building, the row's status is the only feedback there
  // is — so this list polls rather than waiting for a manual refresh.
  const exports = trpc.orgs.exports.useQuery(undefined, { enabled: isAdmin, refetchInterval: 10_000 });

  const [withTelemetry, setWithTelemetry] = useState(false);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const request = trpc.orgs.requestExport.useMutation({
    onSuccess: () => {
      void utils.orgs.exports.invalidate();
      toast.success(t.orgData.requested);
    },
    onError: (e) => toast.error(e.message),
  });
  const link = trpc.orgs.exportLink.useMutation({
    onSuccess: (res) => {
      // Opened immediately rather than shown: the token is short-lived, and a
      // URL sitting on screen is a URL somebody pastes into a chat.
      window.open(res.url, "_blank", "noopener");
    },
    onError: (e) => toast.error(e.message),
  });

  if (!isAdmin) return null;

  const fromDate = toDate(from);
  const toDateVal = toDate(to);
  const rangeOk = !withTelemetry || (fromDate !== null && toDateVal !== null && toDateVal > fromDate);
  const rows = exports.data ?? [];
  const statusLabel = (s: string) =>
    s === "ready"
      ? t.orgData.statusReady
      : s === "running"
        ? t.orgData.statusRunning
        : s === "failed"
          ? t.orgData.statusFailed
          : s === "expired"
            ? t.orgData.statusExpired
            : t.orgData.statusPending;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.orgData.exportTitle}</CardTitle>
        <CardDescription>{t.orgData.exportHint}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-3">
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={withTelemetry} onCheckedChange={() => setWithTelemetry((v) => !v)} />
            {t.orgData.includeTelemetry}
          </label>
          {withTelemetry && (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="export-from">{t.orgData.rangeFrom}</Label>
                <Input id="export-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="export-to">{t.orgData.rangeTo}</Label>
                <Input id="export-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </div>
            </>
          )}
          <Button
            disabled={!rangeOk || request.isPending}
            onClick={() =>
              request.mutate({
                includeTelemetry: withTelemetry,
                ...(withTelemetry && fromDate && toDateVal ? { rangeFrom: fromDate, rangeTo: toDateVal } : {}),
              })
            }
          >
            {request.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Plus className="mr-1 h-4 w-4" />}
            {t.orgData.request}
          </Button>
        </div>
        {!rangeOk && <p className="text-sm text-red-600">{t.orgData.rangeRequired}</p>}

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.common.status}</TableHead>
              <TableHead>{t.orgData.includeTelemetry}</TableHead>
              <TableHead>{t.orgData.size}</TableHead>
              <TableHead>{t.orgData.rows}</TableHead>
              <TableHead>{t.orgData.expires}</TableHead>
              <TableHead className="text-right">{t.common.actions}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((e) => {
              const counts = (e.rowCounts ?? {}) as Record<string, number>;
              const total = Object.values(counts).reduce((a, b) => a + (Number(b) || 0), 0);
              return (
                <TableRow key={e.id}>
                  <TableCell>
                    <span
                      className={
                        e.status === "ready"
                          ? "rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                          : e.status === "failed"
                            ? "rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700 dark:bg-red-950 dark:text-red-300"
                            : "rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                      }
                      title={e.error ?? undefined}
                    >
                      {statusLabel(e.status)}
                    </span>
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {e.includeTelemetry && e.rangeFrom && e.rangeTo
                      ? `${fmtTime(e.rangeFrom)} – ${fmtTime(e.rangeTo)}`
                      : "—"}
                  </TableCell>
                  <TableCell className="text-sm">{fmtBytes(e.sizeBytes)}</TableCell>
                  <TableCell className="text-sm" title={JSON.stringify(counts)}>
                    {total > 0 ? total.toLocaleString() : "—"}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {e.expiresAt ? fmtTime(e.expiresAt) : "—"}
                  </TableCell>
                  <TableCell className="text-right">
                    {e.status === "ready" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={link.isPending}
                        title={t.orgData.downloadHint}
                        onClick={() => link.mutate({ id: e.id })}
                      >
                        <Download className="mr-1 h-3 w-3" />
                        {t.orgData.download}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              );
            })}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-sm text-muted-foreground">
                  {t.orgData.exportEmpty}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
