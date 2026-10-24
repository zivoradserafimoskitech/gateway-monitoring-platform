import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { fmtTime } from "@/components/shared";
import { toast } from "sonner";

const CMDS = ["logs", "sysinfo", "netinfo", "ping", "modbus-scan", "restart-agent"] as const;

/** Run allow-listed diagnostics on a gateway over MQTT and show the replies. */
export function RemoteDiagnosticsCard({ gatewayId }: { gatewayId: number }) {
  const { t } = useI18n();
  const [cmd, setCmd] = useState<(typeof CMDS)[number]>("logs");
  const [arg, setArg] = useState("");
  const history = trpc.diagnostics.remoteHistory.useQuery({ gatewayId }, { refetchInterval: 3000 });
  const run = trpc.diagnostics.remoteRun.useMutation({
    onSuccess: () => history.refetch(),
    onError: (e) => toast.error(e.message),
  });
  const args = (): Record<string, string | number> | undefined => {
    if (!arg) return undefined;
    if (cmd === "logs") return { lines: Number(arg) };
    if (cmd === "ping") return { host: arg };
    return undefined;
  };
  return (
    <Card>
      <CardHeader><CardTitle>{t.remoteDiag.title}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <select className="rounded border bg-background px-2 text-sm" value={cmd} onChange={(e) => setCmd(e.target.value as (typeof CMDS)[number])}>
            {CMDS.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          {(cmd === "logs" || cmd === "ping") && (
            <Input className="w-48" placeholder={cmd === "logs" ? t.remoteDiag.lines : t.remoteDiag.host} value={arg} onChange={(e) => setArg(e.target.value)} />
          )}
          <Button size="sm" disabled={run.isPending} onClick={() => run.mutate({ gatewayId, cmd, args: args() })}>{t.remoteDiag.run}</Button>
        </div>
        {(history.data ?? []).map((r) => (
          <details key={r.id} className="rounded border p-2 text-sm">
            <summary>{fmtTime(new Date(r.createdAt))} · {r.cmd} · {r.status}</summary>
            {r.error && <div className="text-destructive">{r.error}</div>}
            {r.output && <pre className="max-h-80 overflow-auto whitespace-pre-wrap text-xs">{r.output}</pre>}
          </details>
        ))}
        {history.data?.length === 0 && <div className="text-sm text-muted-foreground">{t.remoteDiag.empty}</div>}
      </CardContent>
    </Card>
  );
}
