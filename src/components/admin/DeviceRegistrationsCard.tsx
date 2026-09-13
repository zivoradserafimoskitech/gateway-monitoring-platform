// §1.4: pre-register a gateway UID so the hardware arrives already owned.
//
// The unclaimed queue next to this card is the fallback — it catches devices
// nobody expected. This is the path that stops them landing there at all:
// serial numbers are known before commissioning, so the tenant can be decided
// in advance and the gateway is stamped the moment it first publishes.
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfirmButton } from "@/components/ConfirmButton";
import { fmtTime } from "@/components/shared";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

const NO_SITE = "none";

export function DeviceRegistrationsCard() {
  const { t } = useI18n();
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const isAdmin = !me.data?.authRequired || me.data?.user?.role === "admin";
  const isSuper = me.data?.user?.isSuperadmin === true;

  const registrations = trpc.orgs.registrations.useQuery(undefined, { enabled: isAdmin });
  const orgs = trpc.orgs.list.useQuery(undefined, { enabled: isSuper });
  const sites = trpc.sites.list.useQuery(undefined, { enabled: isAdmin });

  const [uid, setUid] = useState("");
  const [orgId, setOrgId] = useState("");
  const [siteId, setSiteId] = useState(NO_SITE);
  const [note, setNote] = useState("");

  const register = trpc.orgs.registerDevice.useMutation({
    onSuccess: (r) => {
      void utils.orgs.registrations.invalidate();
      void utils.orgs.unclaimedDevices.invalidate();
      void utils.gateways.list.invalidate();
      setUid("");
      setNote("");
      // The hardware may already have been talking to us — say so, because it
      // means the device is owned right now rather than on next connect.
      toast.success(r.claimedNow ? t.admin.regAppliedNow : t.admin.regCreated);
    },
    onError: (e) => toast.error(e.message),
  });
  const remove = trpc.orgs.removeRegistration.useMutation({
    onSuccess: () => void utils.orgs.registrations.invalidate(),
    onError: (e) => toast.error(e.message),
  });

  if (!isAdmin) return null;
  const rows = registrations.data ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.admin.regTitle}</CardTitle>
        <CardDescription>{t.admin.regHint}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <div className="space-y-1.5">
            <Label htmlFor="reg-uid">{t.gateways.uid}</Label>
            <Input
              id="reg-uid"
              className="font-mono"
              placeholder="867156067806820"
              value={uid}
              onChange={(e) => setUid(e.target.value)}
            />
          </div>
          {isSuper && (
            <div className="space-y-1.5">
              <Label>{t.orgs.title}</Label>
              <Select value={orgId} onValueChange={setOrgId}>
                <SelectTrigger>
                  <SelectValue placeholder={t.admin.chooseOrg} />
                </SelectTrigger>
                <SelectContent>
                  {(orgs.data ?? []).map((o) => (
                    <SelectItem key={o.id} value={String(o.id)}>
                      {o.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label>{t.common.site}</Label>
            <Select value={siteId} onValueChange={setSiteId}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NO_SITE}>—</SelectItem>
                {(sites.data ?? []).map((s) => (
                  <SelectItem key={s.id} value={String(s.id)}>
                    {s.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="reg-note">{t.notif.maintNote}</Label>
            <Input id="reg-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </div>
          <div className="flex items-end">
            <Button
              className="w-full"
              disabled={!uid.trim() || (isSuper && !orgId) || register.isPending}
              onClick={() =>
                register.mutate({
                  uid: uid.trim(),
                  ...(orgId ? { orgId: Number(orgId) } : {}),
                  siteId: siteId === NO_SITE ? null : Number(siteId),
                  ...(note.trim() ? { note: note.trim() } : {}),
                })
              }
            >
              {register.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Plus className="mr-1 h-4 w-4" />}
              {t.admin.register}
            </Button>
          </div>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.gateways.uid}</TableHead>
              {isSuper && <TableHead>{t.orgs.title}</TableHead>}
              <TableHead>{t.common.site}</TableHead>
              <TableHead>{t.notif.maintNote}</TableHead>
              <TableHead>{t.common.status}</TableHead>
              <TableHead className="text-right">{t.common.actions}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="font-mono text-xs">{r.uid}</TableCell>
                {isSuper && <TableCell>{r.orgName ?? `#${r.orgId}`}</TableCell>}
                <TableCell className="text-sm">{r.siteName ?? "—"}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{r.note ?? "—"}</TableCell>
                <TableCell>
                  {r.claimedAt ? (
                    <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700">
                      {t.admin.regArrived} · {fmtTime(r.claimedAt)}
                    </span>
                  ) : (
                    <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                      {t.admin.regWaiting}
                    </span>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <ConfirmButton
                    title={`${t.admin.regRemove}: ${r.uid}`}
                    description={t.admin.regRemoveHint}
                    onConfirm={() => remove.mutate({ id: r.id })}
                  />
                </TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={isSuper ? 6 : 5} className="text-sm text-muted-foreground">
                  {t.admin.regEmpty}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
