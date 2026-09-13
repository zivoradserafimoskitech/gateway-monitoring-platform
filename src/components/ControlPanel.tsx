// v7/C12: active control panel — shows the model's writable whitelist with
// range hints, executes setpoints (operator/admin only), and lists the recent
// command history for the device.
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { fmtTime } from "@/components/shared";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { AlertTriangle, Loader2, Send } from "lucide-react";

interface ControllableDef {
  address: number;
  fc?: number;
  min: number;
  max: number;
  scale?: number;
  unit?: string;
  description?: string;
}

export function ControlPanel({ meterId }: { meterId: number }) {
  const { t } = useI18n();
  const me = trpc.auth.me.useQuery();
  const canWrite = me.data?.user?.role === "admin" || me.data?.user?.role === "operator";
  const wl = trpc.control.controllableFor.useQuery({ meterId });
  // Wave 5 / T1: verification state of the meter's device profile — a draft
  // profile blocks control writes; the commissioning override must be visible.
  const profileStatus = trpc.control.profileStatus.useQuery({ meterId });
  const history = trpc.control.history.useQuery({ meterId, limit: 10 }, { refetchInterval: 15000 });
  const utils = trpc.useUtils();
  const execute = trpc.control.execute.useMutation({
    onSettled: () => {
      void utils.control.history.invalidate({ meterId });
    },
  });
  const [values, setValues] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, setPending] = useState<{ key: string; def: ControllableDef; val: number } | null>(null);

  const entries = Object.entries(wl.data ?? {}) as [string, ControllableDef][];
  if (wl.isLoading || entries.length === 0) return null;

  // Wave 5 / T1: draft profile → control unavailable (the server also refuses
  // the write; this is the visible explanation). Override → controls work but
  // carry a persistent warning chip.
  const verification = profileStatus.data;
  const draftBlocked = verification?.verificationStatus === "draft" && !verification.allowUnverifiedControl;
  const overrideActive = verification?.verificationStatus === "draft" && verification.allowUnverifiedControl === true;

  if (draftBlocked) {
    return (
      <Card className="border-amber-200">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 text-amber-600" />
            {t.control.title}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="rounded-md bg-amber-50 p-2 text-sm font-medium text-amber-800">
            {t.control.unavailableUnverified}
          </p>
          <p className="text-xs text-muted-foreground">{t.control.unverifiedHint}</p>
        </CardContent>
      </Card>
    );
  }

  // The confirmation for a setpoint write used window.confirm. After the first
  // one, browsers offer "prevent this page from creating more dialogs" — tick
  // it and every later write goes straight to the device with no confirmation
  // at all. A dialog the page owns cannot be switched off, and it is
  // translated and styled like the rest of the product.
  const ask = (key: string, def: ControllableDef) => {
    const raw = values[key];
    const val = Number(raw);
    if (!raw || !Number.isFinite(val)) {
      setFeedback({ ok: false, text: `${t.control.invalidValue}: ${raw ?? ""}` });
      return;
    }
    setPending({ key, def, val });
  };

  const run = async (key: string, val: number) => {
    setPending(null);
    setFeedback(null);
    try {
      const res = await execute.mutateAsync({ meterId, key, value: val });
      setFeedback({ ok: res.status !== "failed", text: res.detail });
    } catch (err) {
      setFeedback({ ok: false, text: err instanceof Error ? err.message : String(err) });
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.control.title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {overrideActive && (
          <p className="flex items-center gap-2 rounded-md bg-amber-100 p-2 text-sm font-semibold text-amber-800">
            <AlertTriangle className="h-4 w-4" />
            {t.control.commissioningOverride}
          </p>
        )}
        <div className="space-y-2">
          {entries.map(([key, def]) => (
            <div key={key} className="flex flex-wrap items-center gap-2 rounded-md border border-border p-2">
              <div className="min-w-40">
                <div className="text-sm font-medium">{def.description ?? key}</div>
                <div className="text-xs text-muted-foreground">
                  {key} · reg {def.address} · [{def.min}..{def.max}]{def.unit ? ` ${def.unit}` : ""}
                </div>
              </div>
              <input
                type="number"
                className="h-8 w-28 rounded-md border border-border px-2 text-sm disabled:bg-muted/40"
                placeholder={`${def.min}..${def.max}`}
                min={def.min}
                max={def.max}
                step="any"
                disabled={!canWrite || execute.isPending}
                value={values[key] ?? ""}
                onChange={(e) => setValues((v) => ({ ...v, [key]: e.target.value }))}
              />
              <Button
                size="sm"
                disabled={!canWrite || execute.isPending}
                onClick={() => ask(key, def)}
                title={canWrite ? undefined : t.control.readonlyRole}
              >
                {execute.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Send className="h-3 w-3" />}
                {t.control.execute}
              </Button>
            </div>
          ))}
          {!canWrite && <p className="text-xs text-muted-foreground">{t.control.readonlyRole}</p>}
        </div>
        {feedback && (
          <p className={`rounded-md p-2 text-sm ${feedback.ok ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>
            {feedback.text}
          </p>
        )}
        {(history.data ?? []).length > 0 && (
          <div>
            <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t.control.history}</h3>
            <div className="space-y-1 text-sm">
              {(history.data ?? []).map((c) => (
                <div key={c.id} className="flex items-center justify-between border-b border-border py-1">
                  <span className="font-mono text-xs">
                    {c.controlKey ?? c.kind}
                    {c.controlValue !== null && c.controlValue !== undefined ? ` = ${c.controlValue}` : ""}
                  </span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-xs font-medium ${
                      c.status === "ok" ? "bg-emerald-100 text-emerald-700" : c.status === "sent" ? "bg-sky-100 text-sky-700" : "bg-red-100 text-red-700"
                    }`}
                  >
                    {c.status}
                  </span>
                  <span className="text-xs text-muted-foreground">{fmtTime(c.createdAt)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>

      <AlertDialog open={pending !== null} onOpenChange={(o) => !o && setPending(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t.control.confirmExecute}</AlertDialogTitle>
            <AlertDialogDescription className="font-mono text-sm">
              {pending ? `${pending.key} = ${pending.val}${pending.def.unit ? ` ${pending.def.unit}` : ""}` : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t.common.cancel}</AlertDialogCancel>
            <AlertDialogAction onClick={() => pending && void run(pending.key, pending.val)}>
              {t.control.execute}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
