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
import { Network, Pencil, Plus, Trash2 } from "lucide-react";
import { ConfirmButton } from "@/components/ConfirmButton";
import { useSortable } from "@/hooks/use-sortable";
import { SortHeader } from "@/components/SortHeader";
import { toast } from "sonner";

export default function Gateways() {
  const { t } = useI18n();
  const utils = trpc.useUtils();
  const gateways = trpc.gateways.list.useQuery(undefined, { refetchInterval: 5000 });
  // §8: click-to-sort. "Which gateway has been quiet longest" was previously a
  // question you answered by reading every row.
  const { sort, toggle, sorted } = useSortable();
  const rows = sorted(gateways.data ?? [], {
    status: (g) => g.status,
    name: (g) => g.name,
    model: (g) => g.model,
    uid: (g) => g.uid,
    site: (g) => g.siteName,
    meters: (g) => g.meterCount,
    lastSeen: (g) => (g.lastSeenAt ? new Date(g.lastSeenAt) : null),
  });
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
    onError: (e) => toast.error(e.message),
  });

  // §8: gateways.update existed with no screen — a gateway could be created
  // and deleted but never renamed or moved to another site, so a commissioning
  // typo was permanent unless the row was deleted with all its history.
  const [edit, setEdit] = useState<{ id: number; name: string; siteId: string; topicPrefix: string } | null>(null);
  const update = trpc.gateways.update.useMutation({
    onSuccess: () => {
      utils.gateways.list.invalidate();
      setEdit(null);
      toast.success(t.common.save);
    },
    onError: (e) => toast.error(e.message),
  });

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t.gateways.title}</h1>
          <p className="text-sm text-muted-foreground">{t.gateways.subtitle}</p>
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
                <SortHeader column="status" sort={sort} onToggle={toggle}>{t.common.status}</SortHeader>
                <SortHeader column="name" sort={sort} onToggle={toggle}>{t.common.name}</SortHeader>
                <SortHeader column="model" sort={sort} onToggle={toggle}>{t.common.model}</SortHeader>
                <SortHeader column="uid" sort={sort} onToggle={toggle}>{t.gateways.uid}</SortHeader>
                <TableHead>{t.gateways.transport}</TableHead>
                <SortHeader column="site" sort={sort} onToggle={toggle}>{t.common.site}</SortHeader>
                <SortHeader column="meters" sort={sort} onToggle={toggle}>{t.gateways.meters}</SortHeader>
                <SortHeader column="lastSeen" sort={sort} onToggle={toggle}>{t.common.lastSeen}</SortHeader>
                <TableHead className="text-right">{t.common.actions}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((g) => (
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
                  <TableCell className="space-x-1 text-right whitespace-nowrap">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t.common.edit}
                      onClick={() =>
                        setEdit({
                          id: g.id,
                          name: g.name,
                          siteId: g.siteId ? String(g.siteId) : "none",
                          topicPrefix: g.topicPrefix ?? "",
                        })
                      }
                    >
                      <Pencil className="h-4 w-4 text-muted-foreground" />
                    </Button>
                    <ConfirmButton
                      title={t.gateways.deleteConfirm}
                      description={t.gateways.deleteHint}
                      onConfirm={() => remove.mutate({ id: g.id })}
                    />
                  </TableCell>
                </TableRow>
              ))}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={9} className="py-10 text-center text-sm text-muted-foreground">
                    {t.common.noData}. {t.gateways.addHint}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Dialog open={edit !== null} onOpenChange={(o) => !o && setEdit(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.gateways.editGateway}</DialogTitle>
          </DialogHeader>
          {edit && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="edit-gw-name">{t.common.name}</Label>
                <Input
                  id="edit-gw-name"
                  value={edit.name}
                  onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>{t.common.site}</Label>
                <Select value={edit.siteId} onValueChange={(v) => setEdit({ ...edit, siteId: v })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">—</SelectItem>
                    {(sites.data ?? []).map((s2) => (
                      <SelectItem key={s2.id} value={String(s2.id)}>
                        {s2.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-gw-topic">{t.gateways.topicPrefix}</Label>
                <Input
                  id="edit-gw-topic"
                  className="font-mono"
                  value={edit.topicPrefix}
                  onChange={(e) => setEdit({ ...edit, topicPrefix: e.target.value })}
                />
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              disabled={!edit?.name.trim() || update.isPending}
              onClick={() =>
                edit &&
                update.mutate({
                  id: edit.id,
                  name: edit.name.trim(),
                  siteId: edit.siteId === "none" ? null : Number(edit.siteId),
                  topicPrefix: edit.topicPrefix.trim(),
                })
              }
            >
              {t.common.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

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
            <p className="text-xs text-muted-foreground">{t.gateways.addHint}</p>
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

const TIMEZONES = [
  "UTC",
  "Europe/Skopje",
  "Europe/Belgrade",
  "Europe/Zagreb",
  "Europe/Sofia",
  "Europe/Athens",
  "Europe/Berlin",
  "Europe/London",
  "America/New_York",
  "America/Chicago",
  "Asia/Dubai",
  "Asia/Tokyo",
];

function SiteManager() {
  const { t } = useI18n();
  const utils = trpc.useUtils();
  const sites = trpc.sites.list.useQuery();
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState("UTC");
  const create = trpc.sites.create.useMutation({
    onSuccess: () => {
      utils.sites.list.invalidate();
      setName("");
      setTimezone("UTC");
    },
    onError: (e) => toast.error(e.message),
  });
  // §8: sites.update and sites.remove existed with no screen. A site's
  // timezone decides what a "day" means in every report, so a site created
  // with the wrong one silently skewed the numbers and could not be corrected.
  const [edit, setEdit] = useState<{ id: number; name: string; address: string; timezone: string } | null>(null);
  const update = trpc.sites.update.useMutation({
    onSuccess: () => {
      utils.sites.list.invalidate();
      setEdit(null);
      toast.success(t.common.save);
    },
    onError: (e) => toast.error(e.message),
  });
  const removeSite = trpc.sites.remove.useMutation({
    onSuccess: (r) => {
      utils.sites.list.invalidate();
      utils.gateways.list.invalidate();
      utils.meters.list.invalidate();
      // Deleting a site unbinds rather than deletes its hardware; say so, so
      // nobody thinks the gateways went with it.
      toast.success(`${t.settings.siteRemoved} (${r.unboundGateways + r.unboundMeters})`);
    },
    onError: (e) => toast.error(e.message),
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
        <Select value={timezone} onValueChange={setTimezone}>
          <SelectTrigger className="w-44">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {TIMEZONES.map((tz) => (
              <SelectItem key={tz} value={tz}>
                {tz}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          variant="outline"
          disabled={!name.trim() || create.isPending}
          onClick={() => create.mutate({ name: name.trim(), timezone })}
        >
          <Plus className="mr-1 h-4 w-4" /> {t.common.add}
        </Button>
      </div>
      <ul className="flex flex-wrap gap-2">
        {(sites.data ?? []).map((s) => (
          <li key={s.id} className="flex items-center gap-1.5 rounded-full bg-muted py-1 pr-1 pl-3 text-sm">
            {s.name}
            {s.timezone && s.timezone !== "UTC" && (
              <span className="text-xs text-muted-foreground">{s.timezone}</span>
            )}
            <Link
              to={`/sites/${s.id}/diagram`}
              className="inline-flex items-center gap-1 text-xs text-emerald-700 hover:underline"
            >
              <Network className="h-3 w-3" /> {t.diagram.openDiagram}
            </Link>
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6"
              aria-label={t.common.edit}
              onClick={() =>
                setEdit({ id: s.id, name: s.name, address: s.address ?? "", timezone: s.timezone || "UTC" })
              }
            >
              <Pencil className="h-3 w-3 text-muted-foreground" />
            </Button>
            <ConfirmButton
              title={`${t.settings.removeSite}: ${s.name}`}
              description={t.settings.removeSiteHint}
              onConfirm={() => removeSite.mutate({ id: s.id })}
            >
              <Button variant="ghost" size="icon" className="h-6 w-6" aria-label={t.common.delete}>
                <Trash2 className="h-3 w-3 text-red-500" />
              </Button>
            </ConfirmButton>
          </li>
        ))}
        {(sites.data ?? []).length === 0 && <li className="text-sm text-muted-foreground">{t.common.noData}</li>}
      </ul>

      <Dialog open={edit !== null} onOpenChange={(o) => !o && setEdit(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t.settings.editSite}</DialogTitle>
          </DialogHeader>
          {edit && (
            <div className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="edit-site-name">{t.common.name}</Label>
                <Input
                  id="edit-site-name"
                  value={edit.name}
                  onChange={(e) => setEdit({ ...edit, name: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="edit-site-address">{t.common.address}</Label>
                <Input
                  id="edit-site-address"
                  value={edit.address}
                  onChange={(e) => setEdit({ ...edit, address: e.target.value })}
                />
              </div>
              <div className="space-y-2">
                <Label>{t.settings.timezone}</Label>
                <Select value={edit.timezone} onValueChange={(v) => setEdit({ ...edit, timezone: v })}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {TIMEZONES.map((tz) => (
                      <SelectItem key={tz} value={tz}>
                        {tz}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{t.settings.timezoneHint}</p>
              </div>
            </div>
          )}
          <DialogFooter>
            <Button
              disabled={!edit?.name.trim() || update.isPending}
              onClick={() =>
                edit &&
                update.mutate({
                  id: edit.id,
                  name: edit.name.trim(),
                  address: edit.address.trim() || null,
                  timezone: edit.timezone,
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
