import { useState } from "react";
import { Link, useParams } from "react-router";
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
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";

export default function GatewayDetail() {
  const { id } = useParams<{ id: string }>();
  const gatewayId = Number(id);
  const { t } = useI18n();
  const utils = trpc.useUtils();
  const detail = trpc.gateways.get.useQuery({ id: gatewayId }, { refetchInterval: 5000 });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [model, setModel] = useState<"SEM2250" | "SEM3250" | "PEM3000">("PEM3000");
  const [addr, setAddr] = useState("1");

  const createMeter = trpc.meters.create.useMutation({
    onSuccess: () => {
      utils.gateways.get.invalidate({ id: gatewayId });
      setOpen(false);
      setName("");
      toast.success(t.common.save);
    },
    onError: (e) => toast.error(e.message),
  });
  const removeMeter = trpc.meters.remove.useMutation({
    onSuccess: () => utils.gateways.get.invalidate({ id: gatewayId }),
  });
  const readNow = trpc.gateways.readNow.useMutation({
    onSuccess: (r) => {
      utils.gateways.get.invalidate({ id: gatewayId });
      toast.success(`${t.gateways.commandSent}: ${r.topic}`);
    },
    onError: (e) => toast.error(e.message),
  });

  const gw = detail.data?.gateway;
  const meters = detail.data?.meters ?? [];
  const commands = detail.data?.commands ?? [];

  if (!gw) return <p className="text-sm text-slate-500">{t.common.loading}</p>;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-3 text-2xl font-bold tracking-tight">
            {gw.name} <StatusBadge status={gw.status} />
          </h1>
          <p className="text-sm text-slate-500">
            {gw.model} · {t.gateways.uid}: <span className="font-mono">{gw.uid}</span>
          </p>
        </div>
        <Button onClick={() => setOpen(true)} className="gap-2">
          <Plus className="h-4 w-4" /> {t.meters.addMeter}
        </Button>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{t.gateways.transport}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">
            {gw.transport === "transparent" ? t.gateways.transparent : t.gateways.json}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{t.gateways.uplinkTopic}</CardTitle>
          </CardHeader>
          <CardContent className="break-all font-mono text-xs">
            {gw.topicPrefix}/{gw.uid}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">{t.common.lastSeen}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm">{gw.lastSeenAt ? fmtTime(gw.lastSeenAt) : t.common.never}</CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t.gateways.meters}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.common.status}</TableHead>
                <TableHead>{t.common.name}</TableHead>
                <TableHead>{t.common.model}</TableHead>
                <TableHead>{t.meters.modbusAddress}</TableHead>
                <TableHead>{t.meters.channel}</TableHead>
                <TableHead>{t.common.lastSeen}</TableHead>
                <TableHead className="text-right">{t.common.actions}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {meters.map((m) => (
                <TableRow key={m.id}>
                  <TableCell>
                    <StatusBadge status={m.status} />
                  </TableCell>
                  <TableCell>
                    <Link to={`/meters/${m.id}`} className="font-medium text-emerald-700 hover:underline">
                      {m.name}
                    </Link>
                  </TableCell>
                  <TableCell>{m.model}</TableCell>
                  <TableCell className="font-mono">{m.modbusAddress}</TableCell>
                  <TableCell>{m.channel}</TableCell>
                  <TableCell className="text-xs">{m.lastSeenAt ? fmtTime(m.lastSeenAt) : t.common.never}</TableCell>
                  <TableCell className="text-right">
                    <div className="flex justify-end gap-1">
                      {gw.transport === "transparent" && (
                        <Button
                          variant="ghost"
                          size="icon"
                          title={t.gateways.readNow}
                          disabled={readNow.isPending}
                          onClick={() => readNow.mutate({ gatewayId: gw.id, meterId: m.id })}
                        >
                          <RefreshCw className="h-4 w-4 text-slate-500" />
                        </Button>
                      )}
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => {
                          if (confirm(t.meters.deleteConfirm)) removeMeter.mutate({ id: m.id });
                        }}
                      >
                        <Trash2 className="h-4 w-4 text-slate-400" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
              {meters.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="py-10 text-center text-sm text-slate-500">
                    {t.common.noData}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t.gateways.commandLog}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.gateways.sentAt}</TableHead>
                <TableHead>{t.gateways.kind}</TableHead>
                <TableHead>{t.gateways.topic}</TableHead>
                <TableHead>{t.gateways.hexFrame}</TableHead>
                <TableHead>{t.common.status}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {commands.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="text-xs">{fmtTime(c.createdAt)}</TableCell>
                  <TableCell>{c.kind}</TableCell>
                  <TableCell className="font-mono text-xs">{c.topic}</TableCell>
                  <TableCell className="font-mono text-xs">{c.payloadHex}</TableCell>
                  <TableCell>{c.status}</TableCell>
                </TableRow>
              ))}
              {commands.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="py-8 text-center text-sm text-slate-500">
                    {t.common.noData}
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
            <DialogTitle>{t.meters.addMeter}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>{t.common.name}</Label>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Main incomer" />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>{t.common.model}</Label>
                <Select value={model} onValueChange={(v) => setModel(v as typeof model)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="PEM3000">PEM3000 — 3φ</SelectItem>
                    <SelectItem value="SEM3250">SEM3250 — 3φ</SelectItem>
                    <SelectItem value="SEM2250">SEM2250 — 1φ</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>{t.meters.modbusAddress}</Label>
                <Input
                  type="number"
                  min={1}
                  max={247}
                  value={addr}
                  onChange={(e) => setAddr(e.target.value)}
                />
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {t.common.cancel}
            </Button>
            <Button
              disabled={!name.trim() || createMeter.isPending}
              onClick={() =>
                createMeter.mutate({
                  gatewayId: gw.id,
                  name: name.trim(),
                  model,
                  modbusAddress: Number(addr),
                  channel: 1,
                })
              }
            >
              {t.common.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
