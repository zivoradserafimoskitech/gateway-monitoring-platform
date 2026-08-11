// v10 §2a: OTA fleet page — gateway selector, heartbeat/poller diagnostics,
// OTA job table (create/cancel, operator-gated). SPEC-v10 §2 Ota.tsx.
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { fmtTime } from "@/components/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Loader2, Plus, XCircle } from "lucide-react";
import { toast } from "sonner";

type JobType = "firmware" | "config";

export default function Ota() {
  const { t } = useI18n();
  const me = trpc.auth.me.useQuery();
  const canWrite = me.data?.user?.role === "admin" || me.data?.user?.role === "operator";
  const utils = trpc.useUtils();

  const gateways = trpc.gateways.list.useQuery();
  const [pickedId, setPickedId] = useState<number | null>(null);
  const gwRows = gateways.data ?? [];
  // Default: first gateway in the list.
  const gatewayId = pickedId ?? gwRows[0]?.id ?? null;

  const diag = trpc.gateways.diagnostics.useQuery(
    { id: gatewayId as number },
    { enabled: gatewayId != null, refetchInterval: 10000 },
  );
  const jobs = trpc.ota.list.useQuery(
    { gatewayId: gatewayId as number },
    { enabled: gatewayId != null, refetchInterval: 10000 },
  );

  const invalidate = () => {
    if (gatewayId == null) return;
    void utils.ota.list.invalidate({ gatewayId });
    void utils.gateways.diagnostics.invalidate({ id: gatewayId });
  };

  const create = trpc.ota.create.useMutation({
    onSuccess: () => {
      invalidate();
      setOpen(false);
      setVersion("");
      setUrl("");
      toast.success(t.ota.createJob);
    },
    onError: (e) => toast.error(e.message),
  });
  const cancel = trpc.ota.cancel.useMutation({
    onSuccess: invalidate,
    // Backend may reject with BAD_REQUEST (job no longer cancellable).
    onError: (e) => toast.error(e.message),
  });

  // New job dialog state.
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<JobType>("firmware");
  const [version, setVersion] = useState("");
  const [url, setUrl] = useState("");
  const [pollInterval, setPollInterval] = useState("15000");

  const d = diag.data;

  const submit = () => {
    if (gatewayId == null) return;
    const payload: Record<string, unknown> =
      type === "firmware"
        ? { version: version.trim(), ...(url.trim() ? { url: url.trim() } : {}) }
        : { pollIntervalMs: Number(pollInterval) || 0 };
    create.mutate({ gatewayId, type, payload });
  };

  const canSubmit =
    gatewayId != null &&
    !create.isPending &&
    (type === "firmware" ? version.trim().length > 0 : Number(pollInterval) > 0);

  const statusCls = (s: string) =>
    s === "ack"
      ? "bg-emerald-100 text-emerald-700"
      : s === "failed"
        ? "bg-red-100 text-red-700"
        : s === "sent"
          ? "bg-blue-100 text-blue-700"
          : "bg-amber-100 text-amber-700";
  const statusLabel = (s: string) =>
    s === "ack"
      ? t.ota.statusAck
      : s === "failed"
        ? t.ota.statusFailed
        : s === "sent"
          ? t.ota.statusSent
          : t.ota.statusPending;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t.ota.title}</h1>
          <p className="text-sm text-slate-500">{t.ota.subtitle}</p>
        </div>
        {canWrite && (
          <Button className="gap-2" disabled={gatewayId == null} onClick={() => setOpen(true)}>
            <Plus className="h-4 w-4" /> {t.ota.newJob}
          </Button>
        )}
      </div>

      {/* Gateway selector */}
      <div className="max-w-sm space-y-2">
        <Label>{t.ota.gateway}</Label>
        <Select
          value={gatewayId != null ? String(gatewayId) : undefined}
          onValueChange={(v) => setPickedId(Number(v))}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {gwRows.map((g) => (
              <SelectItem key={g.id} value={String(g.id)}>
                {g.name} ({g.uid})
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Diagnostics */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t.ota.diagnostics}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-md border border-slate-200 p-3">
              <p className="text-xs uppercase tracking-wide text-slate-500">{t.ota.lastSeenAt}</p>
              <p className="text-sm">{d?.lastSeenAt ? fmtTime(d.lastSeenAt) : "—"}</p>
            </div>
            <div className="rounded-md border border-slate-200 p-3">
              <p className="text-xs uppercase tracking-wide text-slate-500">{t.ota.msgPerMin}</p>
              <p className="font-mono text-sm">{d ? d.msgPerMin : "—"}</p>
            </div>
            <div className="rounded-md border border-slate-200 p-3">
              <p className="text-xs uppercase tracking-wide text-slate-500">{t.ota.activeJobs}</p>
              <p className="font-mono text-sm">{d?.activeOtaJobs ?? "—"}</p>
            </div>
            <div className="rounded-md border border-slate-200 p-3">
              <p className="text-xs uppercase tracking-wide text-slate-500">{t.ota.samples5min}</p>
              <p className="font-mono text-sm">{d?.samples5min ?? "—"}</p>
            </div>
          </div>
          {d?.poller && d.poller.length > 0 && (
            <div className="rounded-md border border-slate-200 p-3 text-sm">
              <p className="mb-1 text-xs uppercase tracking-wide text-slate-500">{t.ota.pollerStats}</p>
              <div className="space-y-1">
                {d.poller.map((p) => (
                  <div key={p.id} className="flex gap-2 text-xs">
                    <span className="font-medium">
                      {t.ota.device}: {p.name}
                    </span>
                    <span>
                      {t.ota.polls}: {p.polls}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Jobs */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle className="text-base">{t.ota.jobs}</CardTitle>
          {canWrite && (
            <Button size="sm" variant="outline" disabled={gatewayId == null} onClick={() => setOpen(true)}>
              <Plus className="h-3 w-3" /> {t.ota.newJob}
            </Button>
          )}
        </CardHeader>
        <CardContent className="p-0">
          {(jobs.data ?? []).length === 0 ? (
            <p className="py-10 text-center text-sm text-slate-500">{t.ota.empty}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>#</TableHead>
                  <TableHead>{t.ota.type}</TableHead>
                  <TableHead>{t.ota.payload}</TableHead>
                  <TableHead>{t.common.status}</TableHead>
                  <TableHead>{t.ota.attempts}</TableHead>
                  <TableHead>{t.ota.error}</TableHead>
                  <TableHead>{t.ota.created}</TableHead>
                  <TableHead className="text-right">{t.common.actions}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(jobs.data ?? []).map((j) => (
                  <TableRow key={j.id}>
                    <TableCell className="font-mono text-xs">{j.id}</TableCell>
                    <TableCell className="text-xs">
                      {j.type === "firmware" ? t.ota.firmware : t.ota.config}
                    </TableCell>
                    <TableCell
                      className="max-w-56 truncate font-mono text-xs"
                      title={JSON.stringify(j.payload)}
                    >
                      {JSON.stringify(j.payload)}
                    </TableCell>
                    <TableCell>
                      <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${statusCls(j.status)}`}>
                        {statusLabel(j.status)}
                      </span>
                    </TableCell>
                    <TableCell className="text-xs">{j.attempts}</TableCell>
                    <TableCell
                      className={`max-w-48 truncate text-xs ${j.error ? "text-red-600" : "text-slate-400"}`}
                      title={j.error ?? undefined}
                    >
                      {j.error ?? "—"}
                    </TableCell>
                    <TableCell className="text-xs">{fmtTime(j.createdAt)}</TableCell>
                    <TableCell className="text-right">
                      {(j.status === "pending" || j.status === "sent") && canWrite && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={cancel.isPending}
                          onClick={() => {
                            if (confirm(t.ota.cancelConfirm)) cancel.mutate({ id: j.id });
                          }}
                        >
                          <XCircle className="h-3 w-3" /> {t.ota.cancel}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      {/* New job dialog */}
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.ota.newJob}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>{t.ota.type}</Label>
              <Select value={type} onValueChange={(v) => setType(v as JobType)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="firmware">{t.ota.firmware}</SelectItem>
                  <SelectItem value="config">{t.ota.config}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {type === "firmware" ? (
              <>
                <div className="space-y-2">
                  <Label>{t.ota.version}</Label>
                  <Input value={version} onChange={(e) => setVersion(e.target.value)} placeholder="1.4.2" />
                </div>
                <div className="space-y-2">
                  <Label>{t.ota.urlOptional}</Label>
                  <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://…" />
                </div>
              </>
            ) : (
              <div className="space-y-2">
                <Label>{t.ota.pollInterval}</Label>
                <Input
                  type="number"
                  min={1000}
                  value={pollInterval}
                  onChange={(e) => setPollInterval(e.target.value)}
                />
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t.common.cancel}
            </Button>
            <Button disabled={!canSubmit} onClick={submit}>
              {create.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
              {t.ota.createJob}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
