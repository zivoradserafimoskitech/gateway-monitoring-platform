import { useState } from "react";
import { Link } from "react-router";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { StatusBadge, fmtTime } from "@/components/shared";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Plus, Trash2 } from "lucide-react";
import { toast } from "sonner";

export default function Gateways() {
  const { t } = useI18n();
  const utils = trpc.useUtils();
  const gateways = trpc.gateways.list.useQuery(undefined, { refetchInterval: 5000 });
  const sites = trpc.sites.list.useQuery();
  const [open, setOpen] = useState(false);
  const [uid, setUid] = useState("");
  const [name, setName] = useState("");
  const [model, setModel] = useState<"G30" | "C30">("G30");
  const [siteId, setSiteId] = useState<string>("none");

  const create = trpc.gateways.create.useMutation({
    onSuccess: () => {
      utils.gateways.list.invalidate();
      setOpen(false);
      setUid("");
      setName("");
      toast.success(t.common.save);
    },
    onError: (e) => toast.error(e.message),
  });
  const remove = trpc.gateways.remove.useMutation({
    onSuccess: () => utils.gateways.list.invalidate(),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t.gateways.title}</h1>
          <p className="text-sm text-slate-500">{t.gateways.subtitle}</p>
        </div>
        <Button onClick={() => setOpen(true)} className="gap-2">
          <Plus className="h-4 w-4" /> {t.gateways.addGateway}
        </Button>
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.common.status}</TableHead>
                <TableHead>{t.common.name}</TableHead>
                <TableHead>{t.common.model}</TableHead>
                <TableHead>{t.gateways.uid}</TableHead>
                <TableHead>{t.gateways.transport}</TableHead>
                <TableHead>{t.common.site}</TableHead>
                <TableHead>{t.gateways.meters}</TableHead>
                <TableHead>{t.common.lastSeen}</TableHead>
                <TableHead className="text-right">{t.common.actions}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(gateways.data ?? []).map((g) => (
                <TableRow key={g.id}>
                  <TableCell>
                    <StatusBadge status={g.status} />
                  </TableCell>
                  <TableCell>
                    <Link to={`/gateways/${g.id}`} className="font-medium text-emerald-700 hover:underline">
                      {g.name}
                    </Link>
                  </TableCell>
                  <TableCell>{g.model}</TableCell>
                  <TableCell className="font-mono text-xs">{g.uid}</TableCell>
                  <TableCell className="text-xs">
                    {g.transport === "transparent" ? t.gateways.transparent : t.gateways.json}
                  </TableCell>
                  <TableCell>{g.siteName ?? "—"}</TableCell>
                  <TableCell>{g.meterCount}</TableCell>
                  <TableCell className="text-xs">{g.lastSeenAt ? fmtTime(g.lastSeenAt) : t.common.never}</TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => {
                        if (confirm(t.gateways.deleteConfirm)) remove.mutate({ id: g.id });
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-slate-400" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
              {(gateways.data ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="py-10 text-center text-sm text-slate-500">
                    {t.common.noData}. {t.gateways.addHint}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.gateways.addGateway}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>{t.gateways.uid}</Label>
              <Input
                value={uid}
                onChange={(e) => setUid(e.target.value)}
                placeholder="867156067806820"
                className="font-mono"
              />
            </div>
            <div className="space-y-2">
              <Label>{t.common.name}</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Factory gate 1" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t.common.model}</Label>
                <Select value={model} onValueChange={(v) => setModel(v as "G30" | "C30")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="G30">G30 — JSON / Ethernet·4G</SelectItem>
                    <SelectItem value="C30">C30 — 4G transparent</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{t.common.site}</Label>
                <Select value={siteId} onValueChange={setSiteId}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">—</SelectItem>
                    {(sites.data ?? []).map((s) => (
                      <SelectItem key={s.id} value={String(s.id)}>
                        {s.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <p className="text-xs text-slate-500">{t.gateways.addHint}</p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t.common.cancel}
            </Button>
            <Button
              disabled={!uid || !name || create.isPending}
              onClick={() =>
                create.mutate({
                  uid: uid.trim(),
                  name: name.trim(),
                  model,
                  siteId: siteId === "none" ? null : Number(siteId),
                })
              }
            >
              {t.common.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t.settings.sites}</CardTitle>
        </CardHeader>
        <CardContent>
          <SiteManager />
        </CardContent>
      </Card>
    </div>
  );
}

function SiteManager() {
  const { t } = useI18n();
  const utils = trpc.useUtils();
  const sites = trpc.sites.list.useQuery();
  const [name, setName] = useState("");
  const create = trpc.sites.create.useMutation({
    onSuccess: () => {
      utils.sites.list.invalidate();
      setName("");
    },
  });
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t.settings.addSite}
          className="max-w-xs"
        />
        <Button
          variant="outline"
          disabled={!name.trim() || create.isPending}
          onClick={() => create.mutate({ name: name.trim() })}
        >
          <Plus className="mr-1 h-4 w-4" /> {t.common.add}
        </Button>
      </div>
      <ul className="flex flex-wrap gap-2">
        {(sites.data ?? []).map((s) => (
          <li key={s.id} className="rounded-full bg-slate-100 px-3 py-1 text-sm">
            {s.name}
          </li>
        ))}
        {(sites.data ?? []).length === 0 && <li className="text-sm text-slate-500">{t.common.noData}</li>}
      </ul>
    </div>
  );
}
