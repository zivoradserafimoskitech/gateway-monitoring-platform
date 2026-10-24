import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

function GroupRow({ g, onChange }: { g: { id: number; name: string; gatewayIds: number[] }; onChange: () => void }) {
  const { t } = useI18n();
  const [members, setMembers] = useState(g.gatewayIds.join(", "));
  const [payload, setPayload] = useState('{"pollIntervalMs": 60000}');
  const setM = trpc.fleet.setMembers.useMutation({ onSuccess: onChange, onError: (e) => toast.error(e.message) });
  const del = trpc.fleet.deleteGroup.useMutation({ onSuccess: onChange, onError: (e) => toast.error(e.message) });
  const bulk = trpc.fleet.bulkConfig.useMutation({
    onSuccess: (r) => toast.success(t.fleet.queued.replace("{n}", String(r.queued))),
    onError: (e) => toast.error(e.message),
  });
  const push = () => {
    let p: Record<string, unknown>;
    try {
      p = JSON.parse(payload);
    } catch {
      toast.error("Invalid JSON");
      return;
    }
    const n = g.gatewayIds.length;
    if (!window.confirm(t.fleet.bulkConfirm.replace("{n}", String(n)))) return;
    bulk.mutate({ groupId: g.id, payload: p, confirmCount: n });
  };
  return (
    <div className="space-y-2 rounded border p-3">
      <div className="flex items-center justify-between">
        <div className="font-medium">{g.name} <span className="text-xs text-muted-foreground">({g.gatewayIds.length})</span></div>
        <Button size="sm" variant="outline" onClick={() => del.mutate({ id: g.id })}>{t.fleet.remove}</Button>
      </div>
      <div className="flex gap-2">
        <Input placeholder={t.fleet.members} value={members} onChange={(e) => setMembers(e.target.value)} />
        <Button size="sm" onClick={() => setM.mutate({ groupId: g.id, gatewayIds: members.split(",").map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n > 0) })}>{t.fleet.save}</Button>
      </div>
      <div className="flex gap-2">
        <Input placeholder={t.fleet.bulkPayload} value={payload} onChange={(e) => setPayload(e.target.value)} />
        <Button size="sm" disabled={g.gatewayIds.length === 0 || bulk.isPending} onClick={push}>{t.fleet.bulkApply}</Button>
      </div>
    </div>
  );
}

/** Gateway groups: membership and bulk config pushes. */
export function FleetGroupsCard() {
  const { t } = useI18n();
  const [name, setName] = useState("");
  const groups = trpc.fleet.groups.useQuery();
  const create = trpc.fleet.createGroup.useMutation({
    onSuccess: () => { setName(""); groups.refetch(); },
    onError: (e) => toast.error(e.message),
  });
  return (
    <Card>
      <CardHeader><CardTitle>{t.fleet.title}</CardTitle></CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <Input placeholder={t.fleet.newGroup} value={name} onChange={(e) => setName(e.target.value)} />
          <Button size="sm" disabled={!name.trim()} onClick={() => create.mutate({ name: name.trim() })}>{t.fleet.create}</Button>
        </div>
        {(groups.data ?? []).map((g) => <GroupRow key={`${g.id}:${g.gatewayIds.join(",")}`} g={g} onChange={() => groups.refetch()} />)}
      </CardContent>
    </Card>
  );
}
