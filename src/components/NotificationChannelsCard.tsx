// v9.1/B3: notification channels card on Settings — email / Telegram / webhook
// targets for alarm delivery, with escalation flag and enable toggle. Targets
// carry secrets (bot tokens) → displayed truncated. Mutations are operator+.
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Bell, Loader2, Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

type ChannelType = "email" | "telegram" | "webhook";

export function NotificationChannelsCard() {
  const { t } = useI18n();
  const me = trpc.auth.me.useQuery();
  const canWrite = me.data?.user?.role === "admin" || me.data?.user?.role === "operator";
  const utils = trpc.useUtils();
  const channels = trpc.notifications.channels.useQuery();
  const [name, setName] = useState("");
  const [type, setType] = useState<ChannelType>("email");
  const [target, setTarget] = useState("");
  const [escalation, setEscalation] = useState(false);

  const invalidate = () => void utils.notifications.channels.invalidate();
  const create = trpc.notifications.createChannel.useMutation({
    onSuccess: () => {
      invalidate();
      setName(""); setTarget(""); setEscalation(false);
      toast.success(t.notif.created);
    },
    onError: (e) => toast.error(e.message),
  });
  const toggle = trpc.notifications.toggleChannel.useMutation({ onSuccess: invalidate, onError: (e) => toast.error(e.message) });
  const remove = trpc.notifications.removeChannel.useMutation({
    onSuccess: () => {
      invalidate();
      toast.success(t.notif.removed);
    },
    onError: (e) => toast.error(e.message),
  });

  const truncate = (s: string) => (s.length > 18 ? `${s.slice(0, 10)}…${s.slice(-4)}` : s);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bell className="h-4 w-4" /> {t.notif.title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {canWrite && (
          <div className="flex flex-wrap items-center gap-2">
            <Input className="max-w-44" placeholder={t.notif.namePlaceholder} value={name} onChange={(e) => setName(e.target.value)} />
            <Select value={type} onValueChange={(v) => setType(v as ChannelType)}>
              <SelectTrigger className="h-9 w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="email">email</SelectItem>
                <SelectItem value="telegram">telegram</SelectItem>
                <SelectItem value="webhook">webhook</SelectItem>
              </SelectContent>
            </Select>
            <Input
              className="min-w-56 flex-1"
              placeholder={type === "email" ? t.notif.targetEmail : type === "telegram" ? t.notif.targetTelegram : t.notif.targetWebhook}
              value={target}
              onChange={(e) => setTarget(e.target.value)}
            />
            <label className="flex items-center gap-1.5 text-sm">
              <input type="checkbox" checked={escalation} onChange={(e) => setEscalation(e.target.checked)} />
              {t.notif.escalation}
            </label>
            <Button
              size="sm"
              disabled={create.isPending || !name.trim() || !target.trim()}
              onClick={() => create.mutate({ name: name.trim(), type, target: target.trim(), escalation })}
            >
              {create.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
              {t.common.add}
            </Button>
          </div>
        )}

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.orgs.name}</TableHead>
              <TableHead>{t.notif.type}</TableHead>
              <TableHead>{t.notif.target}</TableHead>
              <TableHead>{t.notif.escalation}</TableHead>
              <TableHead>{t.apiKeys.status}</TableHead>
              {canWrite && <TableHead />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {(channels.data ?? []).map((c) => (
              <TableRow key={c.id} className={c.enabled ? "" : "opacity-50"}>
                <TableCell>{c.name}</TableCell>
                <TableCell>{c.type}</TableCell>
                <TableCell className="font-mono text-xs" title={c.type === "email" ? c.target : undefined}>
                  {c.type === "email" ? c.target : truncate(c.target)}
                </TableCell>
                <TableCell>{c.escalation ? "✓" : "—"}</TableCell>
                <TableCell>
                  {canWrite ? (
                    <Button size="sm" variant="ghost" disabled={toggle.isPending} onClick={() => toggle.mutate({ id: c.id, enabled: !c.enabled })}>
                      {c.enabled ? t.notif.enabled : t.notif.disabled}
                    </Button>
                  ) : c.enabled ? t.notif.enabled : t.notif.disabled}
                </TableCell>
                {canWrite && (
                  <TableCell className="text-right">
                    <Button size="sm" variant="ghost" disabled={remove.isPending} onClick={() => remove.mutate({ id: c.id })}>
                      <Trash2 className="h-3 w-3 text-red-500" />
                    </Button>
                  </TableCell>
                )}
              </TableRow>
            ))}
            {(channels.data ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-center text-sm text-slate-400">
                  {t.notif.empty}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
