// v8/D5: device-management card on GatewayDetail — firmware/config versions,
// heartbeat diagnostics (last seen, msg/min, poller stats, in-flight jobs),
// OTA job form + live job list with cancel. Operator-gated writes.
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtTime } from "@/components/shared";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

export function DeviceManagementCard({ gatewayId }: { gatewayId: number }) {
  const { t } = useI18n();
  const me = trpc.auth.me.useQuery();
  const canWrite = me.data?.user?.role === "admin" || me.data?.user?.role === "operator";
  const utils = trpc.useUtils();

  const diag = trpc.gateways.diagnostics.useQuery({ id: gatewayId }, { refetchInterval: 10000 });
  const jobs = trpc.ota.list.useQuery({ gatewayId }, { refetchInterval: 5000 });
  const invalidate = () => {
    void utils.ota.list.invalidate({ gatewayId });
    void utils.gateways.diagnostics.invalidate({ id: gatewayId });
  };
  const create = trpc.ota.create.useMutation({
    onSuccess: () => {
      invalidate();
      setShowForm(false);
      toast.success(t.gateways.commandSent);
    },
    onError: (e) => toast.error(e.message),
  });
  const cancel = trpc.ota.cancel.useMutation({ onSuccess: invalidate, onError: (e) => toast.error(e.message) });

  const [showForm, setShowForm] = useState(false);
  const [type, setType] = useState<"firmware" | "config">("config");
  const [payloadText, setPayloadText] = useState('{"pollIntervalMs":15000}');

  const d = diag.data;

  const submit = () => {
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(payloadText);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object");
      payload = parsed;
    } catch {
      toast.error(t.gateways.invalidPayload);
      return;
    }
    create.mutate({ gatewayId, type, payload });
  };

  const statusCls = (s: string) =>
    s === "ack" ? "bg-emerald-100 text-emerald-700" : s === "failed" ? "bg-red-100 text-red-700" : s === "sent" ? "bg-sky-100 text-sky-700" : "bg-amber-100 text-amber-700";

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>{t.gateways.deviceManagement}</CardTitle>
        {canWrite && (
          <Button size="sm" variant="outline" onClick={() => setShowForm((v) => !v)}>
            <Plus className="h-3 w-3" /> {t.gateways.newOtaJob}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        {/* versions + heartbeat diagnostics */}
        <div className="grid gap-3 md:grid-cols-4">
          <div className="rounded-md border border-slate-200 p-3">
            <p className="text-xs uppercase tracking-wide text-slate-500">{t.gateways.firmwareVersion}</p>
            <p className="font-mono text-sm">{d?.firmwareVersion ?? "—"}</p>
          </div>
          <div className="rounded-md border border-slate-200 p-3">
            <p className="text-xs uppercase tracking-wide text-slate-500">{t.gateways.configVersion}</p>
            <p className="font-mono text-sm">{d?.configVersion ?? "—"}</p>
          </div>
          <div className="rounded-md border border-slate-200 p-3">
            <p className="text-xs uppercase tracking-wide text-slate-500">{t.common.lastSeen}</p>
            <p className="text-sm">{d?.lastSeenAt ? fmtTime(d.lastSeenAt) : t.common.never}</p>
          </div>
          <div className="rounded-md border border-slate-200 p-3">
            <p className="text-xs uppercase tracking-wide text-slate-500">{t.gateways.msgPerMin}</p>
            <p className="font-mono text-sm">
              {d ? d.msgPerMin : "—"} <span className="text-xs text-slate-400">({t.gateways.samples5min}: {d?.samples5min ?? 0})</span>
            </p>
          </div>
        </div>
        {d?.poller && d.poller.length > 0 && (
          <div className="rounded-md border border-slate-200 p-3 text-sm">
            <p className="mb-1 text-xs uppercase tracking-wide text-slate-500">{t.gateways.pollerStats}</p>
            <div className="space-y-1">
              {d.poller.map((p) => (
                <div key={p.id} className="flex flex-wrap gap-2 text-xs">
                  <span className="font-medium">{p.name}</span>
                  <span>polls {p.polls}</span>
                  <span className={p.failures > 0 ? "text-red-600" : "text-slate-500"}>fail {p.failures}</span>
                  <span className="text-slate-400">{p.lastOkAt ? fmtTime(p.lastOkAt) : t.common.never}</span>
                  {p.lastError && <span className="text-red-600">{p.lastError}</span>}
                </div>
              ))}
            </div>
          </div>
        )}
        <p className="text-xs text-slate-500">
          {t.gateways.activeOtaJobs}: {d?.activeOtaJobs ?? 0}
        </p>

        {/* job form */}
        {showForm && canWrite && (
          <div className="grid items-end gap-3 rounded-md border border-slate-200 bg-slate-50 p-3 md:grid-cols-[160px_1fr_auto]">
            <div className="space-y-1">
              <Label>{t.gateways.jobType}</Label>
              <Select
                value={type}
                onValueChange={(v) => {
                  const nt = v as "firmware" | "config";
                  setType(nt);
                  setPayloadText(nt === "firmware" ? t.gateways.payloadHintFirmware : t.gateways.payloadHintConfig);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="config">{t.gateways.typeConfig}</SelectItem>
                  <SelectItem value="firmware">{t.gateways.typeFirmware}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>{t.gateways.payloadJson}</Label>
              <Input className="font-mono text-xs" value={payloadText} onChange={(e) => setPayloadText(e.target.value)} />
            </div>
            <Button size="sm" disabled={create.isPending} onClick={submit}>
              {create.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
              {t.common.add}
            </Button>
          </div>
        )}

        {/* jobs */}
        {(jobs.data ?? []).length === 0 ? (
          <p className="text-sm text-slate-500">{t.gateways.noJobs}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>{t.gateways.jobType}</TableHead>
                <TableHead>{t.gateways.payloadJson}</TableHead>
                <TableHead>{t.common.status}</TableHead>
                <TableHead>{t.gateways.attempts}</TableHead>
                <TableHead>{t.gateways.sentAt}</TableHead>
                <TableHead>{t.gateways.ackedAt}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {(jobs.data ?? []).map((j) => (
                <TableRow key={j.id}>
                  <TableCell className="font-mono text-xs">{j.id}</TableCell>
                  <TableCell className="text-xs">{j.type === "firmware" ? t.gateways.typeFirmware : t.gateways.typeConfig}</TableCell>
                  <TableCell className="max-w-56 truncate font-mono text-xs" title={JSON.stringify(j.payload)}>
                    {JSON.stringify(j.payload)}
                  </TableCell>
                  <TableCell>
                    <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${statusCls(j.status)}`}>{j.status}</span>
                    {j.error && <p className="mt-0.5 max-w-48 truncate text-xs text-red-600" title={j.error}>{j.error}</p>}
                  </TableCell>
                  <TableCell className="text-xs">{j.attempts}</TableCell>
                  <TableCell className="text-xs">{j.sentAt ? fmtTime(j.sentAt) : "—"}</TableCell>
                  <TableCell className="text-xs">{j.ackAt ? fmtTime(j.ackAt) : "—"}</TableCell>
                  <TableCell className="text-right">
                    {j.status === "pending" && canWrite && (
                      <Button size="sm" variant="outline" disabled={cancel.isPending} onClick={() => cancel.mutate({ id: j.id })}>
                        {t.gateways.cancelJob}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        {!canWrite && <p className="text-xs text-slate-500">{t.gateways.readonlyRole}</p>}
      </CardContent>
    </Card>
  );
}
