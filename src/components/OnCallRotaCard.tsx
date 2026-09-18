// §9.8: the on-call rota.
//
// Without one, every enabled channel receives every alarm at every hour, which
// is how a 03:00 page reaches six people who cannot act on it and one who can.
//
// The screen is deliberate about two things the API is deliberate about too:
// a rota with no shifts changes nothing (every channel is notified, exactly as
// before), and an hour no shift covers still delivers to everyone — dispatch
// fails open, because a duplicate page is recoverable and a missed one is not.
// The warning below is how an operator finds out the rota has a hole in it.
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { useNow } from "@/hooks/use-now";
import { useI18n } from "@/i18n";
import { onDutyChannelIds, type ShiftRow } from "@contracts/oncall";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfirmButton } from "@/components/ConfirmButton";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

const ALL_DAYS = 0b1111111;

function hhmmToMin(s: string): number {
  const [h, m] = s.split(":").map(Number);
  return (h || 0) * 60 + (m || 0);
}
function minToHhmm(min: number): string {
  return `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;
}

export function OnCallRotaCard() {
  const { t } = useI18n();
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const canWrite = !me.data?.authRequired || me.data?.user?.role === "admin" || me.data?.user?.role === "operator";

  const shifts = trpc.notifications.onCall.useQuery();
  const channels = trpc.notifications.channels.useQuery();

  const [channelId, setChannelId] = useState("");
  const [mask, setMask] = useState(ALL_DAYS);
  const [from, setFrom] = useState("08:00");
  const [to, setTo] = useState("17:00");
  // The browser's own zone is the right default: the person filling this in is
  // almost always describing their own working hours.
  const [tz, setTz] = useState(() => {
    try {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return "UTC";
    }
  });

  const invalidate = () => void utils.notifications.onCall.invalidate();
  const create = trpc.notifications.createShift.useMutation({
    onSuccess: () => {
      invalidate();
      setChannelId("");
      toast.success(t.notif.rotaCreated);
    },
    onError: (e) => toast.error(e.message),
  });
  const toggle = trpc.notifications.toggleShift.useMutation({
    onSuccess: invalidate,
    onError: (e) => toast.error(e.message),
  });
  const remove = trpc.notifications.removeShift.useMutation({
    onSuccess: invalidate,
    onError: (e) => toast.error(e.message),
  });

  const now = useNow();
  const rows = shifts.data ?? [];
  // Same function the dispatcher uses, imported from contracts/ — the badge
  // cannot drift from who actually gets paged.
  const rota: ShiftRow[] = rows.map((r) => ({
    channelId: r.channelId,
    dayOfWeekMask: r.dayOfWeekMask,
    startMin: r.startMin,
    endMin: r.endMin,
    timezone: r.timezone,
    enabled: r.enabled,
  }));
  const onDuty = onDutyChannelIds(rota, new Date(now));
  const gap = onDuty !== null && onDuty.size === 0;

  const toggleDay = (d: number) => setMask((m) => m ^ (1 << d));
  const valid = channelId !== "" && mask !== 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.notif.rotaTitle}</CardTitle>
        <CardDescription>{t.notif.rotaHint}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {canWrite && (
          <div className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="space-y-1.5">
                <Label>{t.notif.rotaChannel}</Label>
                <Select value={channelId} onValueChange={setChannelId}>
                  <SelectTrigger>
                    <SelectValue placeholder={t.notif.rotaChannel} />
                  </SelectTrigger>
                  <SelectContent>
                    {(channels.data ?? []).map((c) => (
                      <SelectItem key={c.id} value={String(c.id)}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rota-from">{t.notif.rotaFrom}</Label>
                <Input id="rota-from" type="time" value={from} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rota-to">{t.notif.rotaTo}</Label>
                <Input id="rota-to" type="time" value={to} onChange={(e) => setTo(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="rota-tz">{t.notif.rotaTz}</Label>
                <Input id="rota-tz" value={tz} onChange={(e) => setTz(e.target.value)} />
              </div>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div className="space-y-1.5">
                <Label>{t.ems.days}</Label>
                <div className="flex flex-wrap gap-1">
                  {t.ems.dayLabels.map((label, d) => (
                    <Button
                      key={label}
                      type="button"
                      size="sm"
                      variant={(mask >> d) & 1 ? "default" : "outline"}
                      onClick={() => toggleDay(d)}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
              </div>
              <Button
                disabled={!valid || create.isPending}
                onClick={() =>
                  create.mutate({
                    channelId: Number(channelId),
                    dayOfWeekMask: mask,
                    startMin: hhmmToMin(from),
                    endMin: hhmmToMin(to),
                    timezone: tz,
                  })
                }
              >
                {create.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Plus className="mr-1 h-4 w-4" />}
                {t.common.add}
              </Button>
            </div>
            {mask === 0 && <p className="text-sm text-red-600">{t.notif.rotaDaysRequired}</p>}
          </div>
        )}
        {gap && (
          <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
            {t.notif.rotaGapWarning}
          </p>
        )}
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.notif.rotaChannel}</TableHead>
              <TableHead>{t.ems.days}</TableHead>
              <TableHead>{t.notif.rotaWhen}</TableHead>
              <TableHead>{t.notif.rotaTz}</TableHead>
              <TableHead>{t.common.status}</TableHead>
              {canWrite && <TableHead className="text-right">{t.common.actions}</TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((s) => (
              <TableRow key={s.id}>
                <TableCell>{s.channelName ?? `#${s.channelId}`}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {s.dayOfWeekMask === ALL_DAYS
                    ? t.notif.rotaEveryDay
                    : t.ems.dayLabels.filter((_, d) => (s.dayOfWeekMask >> d) & 1).join(" ")}
                </TableCell>
                <TableCell className="whitespace-nowrap text-sm">
                  {s.startMin === s.endMin
                    ? t.notif.rotaAllDay
                    : `${minToHhmm(s.startMin)}–${minToHhmm(s.endMin)}`}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">{s.timezone}</TableCell>
                <TableCell>
                  {onDuty?.has(s.channelId) && s.enabled ? (
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300">
                      {t.notif.rotaOnDuty}
                    </span>
                  ) : (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      {s.enabled ? t.notif.enabled : t.notif.disabled}
                    </span>
                  )}
                </TableCell>
                {canWrite && (
                  <TableCell className="space-x-1 text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={toggle.isPending}
                      onClick={() => toggle.mutate({ id: s.id, enabled: !s.enabled })}
                    >
                      {s.enabled ? t.notif.disabled : t.notif.enabled}
                    </Button>
                    <ConfirmButton
                      title={t.notif.rotaRemoveTitle}
                      description={t.notif.rotaRemoveHint}
                      onConfirm={() => remove.mutate({ id: s.id })}
                    />
                  </TableCell>
                )}
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={canWrite ? 6 : 5} className="text-sm text-muted-foreground">
                  {t.notif.rotaEmpty}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
