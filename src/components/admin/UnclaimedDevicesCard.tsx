// §1.4: MQTT auto-provisioning creates a gateway (and its meters) the first
// time hardware speaks, before anyone has said which tenant owns it, so the
// rows land with org_id NULL — invisible to every tenant under org scoping.
// The hardware ingests into a database nobody can see, which looks exactly
// like a device that never connected. This is the queue that makes that state
// visible, and the one action that ends it.
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { DeviceTypeBadge, fmtTime } from "@/components/shared";
import { Inbox, Loader2 } from "lucide-react";
import { toast } from "sonner";

export function UnclaimedDevicesCard() {
  const { t } = useI18n();
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const isSuper = me.data?.user?.isSuperadmin === true;
  const unclaimed = trpc.orgs.unclaimedDevices.useQuery(undefined, {
    enabled: isSuper,
    refetchInterval: 30_000,
  });
  const orgs = trpc.orgs.list.useQuery(undefined, { enabled: isSuper });
  // One org selection per row: claiming several devices into different tenants
  // in one sitting is the normal case after a commissioning day.
  const [target, setTarget] = useState<Record<string, string>>({});

  const invalidate = () => {
    void utils.orgs.unclaimedDevices.invalidate();
    void utils.gateways.list.invalidate();
    void utils.meters.list.invalidate();
  };
  const claimGateway = trpc.orgs.claimGateway.useMutation({
    onSuccess: (r) => {
      invalidate();
      toast.success(`${t.admin.claimed} (${r.devices} ${t.nav.meters.toLowerCase()})`);
    },
    onError: (e) => toast.error(e.message),
  });
  const claimDevice = trpc.orgs.claimDevice.useMutation({
    onSuccess: () => {
      invalidate();
      toast.success(t.admin.claimed);
    },
    onError: (e) => toast.error(e.message),
  });

  if (!isSuper) return null;

  const orgSelect = (key: string) => (
    <Select value={target[key] ?? ""} onValueChange={(v) => setTarget((s) => ({ ...s, [key]: v }))}>
      <SelectTrigger className="h-8 w-44">
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
  );

  const data = unclaimed.data;
  const empty = !data || data.total === 0;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Inbox className="h-4 w-4" />
          {t.admin.unclaimedTitle}
          {data && data.total > 0 ? (
            <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-medium text-amber-700">
              {data.total}
            </span>
          ) : null}
        </CardTitle>
        <CardDescription>{t.admin.unclaimedHint}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {empty ? (
          <p className="text-sm text-slate-500">{t.admin.unclaimedEmpty}</p>
        ) : (
          <>
            {data.gateways.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-medium text-slate-700">{t.nav.gateways}</h3>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t.gateways.uid}</TableHead>
                      <TableHead>{t.common.name}</TableHead>
                      <TableHead>{t.common.lastSeen}</TableHead>
                      <TableHead className="text-right">{t.admin.claimTo}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.gateways.map((g) => (
                      <TableRow key={g.id}>
                        <TableCell className="font-mono text-xs">{g.uid}</TableCell>
                        <TableCell>{g.name}</TableCell>
                        <TableCell className="text-sm text-slate-500">{fmtTime(g.lastSeenAt)}</TableCell>
                        <TableCell>
                          <div className="flex items-center justify-end gap-2">
                            {orgSelect(`g${g.id}`)}
                            <Button
                              size="sm"
                              disabled={!target[`g${g.id}`] || claimGateway.isPending}
                              onClick={() =>
                                claimGateway.mutate({ gatewayId: g.id, orgId: Number(target[`g${g.id}`]) })
                              }
                            >
                              {claimGateway.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                              {t.admin.claim}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
                <p className="text-xs text-slate-500">{t.admin.claimCascade}</p>
              </div>
            )}
            {data.devices.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-sm font-medium text-slate-700">{t.nav.meters}</h3>
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>{t.common.name}</TableHead>
                      <TableHead>{t.common.type}</TableHead>
                      <TableHead>{t.common.model}</TableHead>
                      <TableHead>{t.common.lastSeen}</TableHead>
                      <TableHead className="text-right">{t.admin.claimTo}</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.devices.map((m) => (
                      <TableRow key={m.id}>
                        <TableCell>{m.name}</TableCell>
                        <TableCell>
                          <DeviceTypeBadge type={m.deviceType ?? "meter"} />
                        </TableCell>
                        <TableCell className="text-sm text-slate-500">{m.model ?? "—"}</TableCell>
                        <TableCell className="text-sm text-slate-500">{fmtTime(m.lastSeenAt)}</TableCell>
                        <TableCell>
                          <div className="flex items-center justify-end gap-2">
                            {orgSelect(`m${m.id}`)}
                            <Button
                              size="sm"
                              disabled={!target[`m${m.id}`] || claimDevice.isPending}
                              onClick={() => claimDevice.mutate({ meterId: m.id, orgId: Number(target[`m${m.id}`]) })}
                            >
                              {claimDevice.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                              {t.admin.claim}
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}
