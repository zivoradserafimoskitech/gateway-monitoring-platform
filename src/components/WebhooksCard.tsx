// §9.15: outbound webhook subscriptions (admin only).
//
// Deliberately separate from notification channels even though both POST JSON
// at a URL. A channel is a way to tell a person; this is a way to tell a
// system, which needs three things a channel does not have: a signature the
// receiver can verify, a queue so a delivery that fails is retried rather than
// dropped, and control events as well as alarms.
//
// The signing secret is shown exactly once, like an API key. It is stored in
// plaintext server-side because it must be reproduced to sign each delivery —
// but there is no reason to keep handing it back on every page load.
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { WEBHOOK_EVENTS, type WebhookEvent } from "@contracts/webhook-events";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfirmButton } from "@/components/ConfirmButton";
import { fmtTime } from "@/components/shared";
import { Check, Copy, Loader2, Plus, RefreshCw, Webhook } from "lucide-react";
import { toast } from "sonner";

export function WebhooksCard() {
  const { t } = useI18n();
  const me = trpc.auth.me.useQuery();
  const isAdmin = me.data?.user?.role === "admin";
  const utils = trpc.useUtils();
  const subs = trpc.webhooks.list.useQuery(undefined, { enabled: isAdmin });

  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [events, setEvents] = useState<WebhookEvent[]>(["alarm.raised"]);
  const [freshSecret, setFreshSecret] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const invalidate = () => void utils.webhooks.list.invalidate();
  const create = trpc.webhooks.create.useMutation({
    onSuccess: (res) => {
      invalidate();
      setName("");
      setUrl("");
      setFreshSecret(res.secret); // the only time it is shown
      toast.success(t.webhooks.created);
    },
    onError: (e) => toast.error(e.message),
  });
  const update = trpc.webhooks.update.useMutation({ onSuccess: invalidate, onError: (e) => toast.error(e.message) });
  const rotate = trpc.webhooks.rotateSecret.useMutation({
    onSuccess: (res) => {
      setFreshSecret(res.secret);
      toast.success(t.webhooks.rotated);
    },
    onError: (e) => toast.error(e.message),
  });
  const remove = trpc.webhooks.remove.useMutation({
    onSuccess: () => {
      invalidate();
      toast.success(t.webhooks.removed);
    },
    onError: (e) => toast.error(e.message),
  });

  if (!isAdmin) return null;

  const toggleEvent = (e: WebhookEvent) =>
    setEvents((prev) => (prev.includes(e) ? prev.filter((x) => x !== e) : [...prev, e]));

  const copy = async () => {
    if (!freshSecret) return;
    try {
      await navigator.clipboard.writeText(freshSecret);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t.webhooks.copyFailed);
    }
  };

  const rows = subs.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Webhook className="h-4 w-4" /> {t.webhooks.title}
        </CardTitle>
        <CardDescription>{t.webhooks.hint}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="max-w-56"
            placeholder={t.webhooks.namePlaceholder}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <Input
            className="max-w-96 flex-1"
            placeholder={t.webhooks.url}
            value={url}
            onChange={(e) => setUrl(e.target.value)}
          />
          {WEBHOOK_EVENTS.map((e) => (
            <label key={e} className="flex items-center gap-1.5 font-mono text-xs">
              <Checkbox checked={events.includes(e)} onCheckedChange={() => toggleEvent(e)} />
              {e}
            </label>
          ))}
          <Button
            size="sm"
            disabled={create.isPending || !name.trim() || !url.trim() || events.length === 0}
            onClick={() => create.mutate({ name: name.trim(), url: url.trim(), events })}
          >
            {create.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
            {t.common.add}
          </Button>
        </div>
        {events.length === 0 && <p className="text-sm text-red-600">{t.webhooks.eventsRequired}</p>}

        {freshSecret && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950">
            <p className="mb-1 text-xs font-medium text-amber-800 dark:text-amber-200">{t.webhooks.showOnce}</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all rounded bg-card px-2 py-1 font-mono text-xs">{freshSecret}</code>
              <Button size="sm" variant="outline" onClick={() => void copy()}>
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              </Button>
            </div>
            <p className="mt-2 text-xs text-amber-800 dark:text-amber-200">{t.webhooks.signatureHint}</p>
          </div>
        )}

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.common.name}</TableHead>
              <TableHead>{t.webhooks.url}</TableHead>
              <TableHead>{t.webhooks.events}</TableHead>
              <TableHead>{t.common.status}</TableHead>
              <TableHead>{t.webhooks.lastSuccess}</TableHead>
              <TableHead className="text-right">{t.common.actions}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((s) => {
              const evts = Array.isArray(s.events) ? (s.events as string[]) : [];
              return (
                <TableRow key={s.id}>
                  <TableCell className="font-medium">{s.name}</TableCell>
                  <TableCell className="max-w-64 truncate font-mono text-xs" title={s.url}>
                    {s.url}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">{evts.join(" ")}</TableCell>
                  <TableCell>
                    {/* The failure count is shown, never acted on: a
                        subscription that disables itself is how a customer
                        finds out weeks later that their system went quiet. */}
                    {s.consecutiveFailures > 0 ? (
                      <span
                        className="rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700 dark:bg-red-950 dark:text-red-300"
                        title={s.lastError ?? undefined}
                      >
                        {t.webhooks.failing} ({s.consecutiveFailures})
                      </span>
                    ) : (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                        {s.enabled ? t.webhooks.healthy : t.notif.disabled}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap text-xs">
                    {s.lastSuccessAt ? fmtTime(s.lastSuccessAt) : t.webhooks.never}
                  </TableCell>
                  <TableCell className="space-x-1 text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={update.isPending}
                      onClick={() => update.mutate({ id: s.id, enabled: !s.enabled })}
                    >
                      {s.enabled ? t.notif.disabled : t.notif.enabled}
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={rotate.isPending}
                      onClick={() => rotate.mutate({ id: s.id })}
                      title={t.webhooks.rotate}
                    >
                      <RefreshCw className="h-3 w-3" />
                    </Button>
                    <ConfirmButton
                      title={t.webhooks.removeTitle}
                      description={t.webhooks.removeHint}
                      onConfirm={() => remove.mutate({ id: s.id })}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-sm text-muted-foreground">
                  {t.webhooks.empty}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
