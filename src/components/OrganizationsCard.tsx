// v8/D2: organizations card on Settings — superadmin only. Create orgs, see
// per-org usage counts, reassign users between orgs. Bare-bones by design:
// the org tRPC API is the deliverable.
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

export function OrganizationsCard() {
  const { t } = useI18n();
  const me = trpc.auth.me.useQuery();
  const isSuper = me.data?.user?.isSuperadmin === true;
  const utils = trpc.useUtils();
  const orgs = trpc.orgs.list.useQuery(undefined, { enabled: isSuper });
  const users = trpc.auth.users.useQuery(undefined, { enabled: isSuper });
  const [name, setName] = useState("");
  const create = trpc.orgs.create.useMutation({
    onSuccess: () => {
      void utils.orgs.list.invalidate();
      setName("");
      toast.success(t.orgs.created);
    },
    onError: (e) => toast.error(e.message),
  });
  const assign = trpc.orgs.assignUser.useMutation({
    onSuccess: () => {
      void utils.auth.users.invalidate();
      toast.success(t.orgs.assigned);
    },
    onError: (e) => toast.error(e.message),
  });
  if (!isSuper) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.orgs.title}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex gap-2">
          <Input className="max-w-64" placeholder={t.orgs.namePlaceholder} value={name} onChange={(e) => setName(e.target.value)} />
          <Button size="sm" disabled={create.isPending || !name.trim()} onClick={() => create.mutate({ name: name.trim() })}>
            {create.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
            {t.common.add}
          </Button>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>#</TableHead>
              <TableHead>{t.orgs.name}</TableHead>
              <TableHead>{t.orgs.users}</TableHead>
              <TableHead>{t.common.sites}</TableHead>
              <TableHead>{t.orgs.gateways}</TableHead>
              <TableHead>{t.orgs.devices}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(orgs.data ?? []).map((o) => (
              <TableRow key={o.id}>
                <TableCell className="font-mono text-xs">{o.id}</TableCell>
                <TableCell>{o.name}</TableCell>
                <TableCell>{o.counts.users}</TableCell>
                <TableCell>{o.counts.sites}</TableCell>
                <TableCell>{o.counts.gateways}</TableCell>
                <TableCell>{o.counts.devices}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <div>
          <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">{t.orgs.reassign}</h3>
          <div className="space-y-1">
            {(users.data ?? [])
              .filter((u) => !u.isSuperadmin)
              .map((u) => (
                <div key={u.id} className="flex items-center gap-2 text-sm">
                  <span className="min-w-56">{u.email}</span>
                  <Select
                    value={String(u.orgId ?? "")}
                    onValueChange={(v) => assign.mutate({ userId: u.id, orgId: Number(v) })}
                    disabled={assign.isPending}
                  >
                    <SelectTrigger className="h-8 w-48">
                      <SelectValue />
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
              ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
