// §9.2: the site's grid connection limit and its curtailment order.
//
// The limit itself is two numbers and a meter; the part that needs care on
// screen is the ORDER, because that is the operator's decision about which
// generation is sacrificed first and it is otherwise invisible in a database
// column. Priority ascending, lowest curtailed first, stated plainly.
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
import { Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

export function GridLimitCard() {
  const { t } = useI18n();
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const canWrite = !me.data?.authRequired || me.data?.user?.role === "admin" || me.data?.user?.role === "operator";

  const sites = trpc.sites.list.useQuery();
  const meters = trpc.meters.list.useQuery();
  const limits = trpc.ems.gridLimits.list.useQuery(undefined, { refetchInterval: 15_000 });

  const [siteId, setSiteId] = useState<string>("");
  const selectedSite = siteId ? Number(siteId) : null;
  const existing = (limits.data ?? []).find((l) => l.siteId === selectedSite);

  const assets = trpc.ems.gridLimits.assets.useQuery(
    { siteId: selectedSite ?? 0 },
    { enabled: selectedSite !== null },
  );

  const [pccMeterId, setPccMeterId] = useState("");
  const [maxImportKw, setMaxImportKw] = useState("");
  const [maxExportKw, setMaxExportKw] = useState("");
  const [assetMeterId, setAssetMeterId] = useState("");
  const [assetRatedKw, setAssetRatedKw] = useState("");
  const [assetPriority, setAssetPriority] = useState("100");

  const invalidate = () => {
    void utils.ems.gridLimits.list.invalidate();
    if (selectedSite !== null) void utils.ems.gridLimits.assets.invalidate({ siteId: selectedSite });
  };
  const upsert = trpc.ems.gridLimits.upsert.useMutation({
    onSuccess: () => {
      invalidate();
      toast.success(t.grid.saved);
    },
    onError: (e) => toast.error(e.message),
  });
  const addAsset = trpc.ems.gridLimits.addAsset.useMutation({
    onSuccess: () => {
      invalidate();
      setAssetMeterId("");
      setAssetRatedKw("");
      toast.success(t.grid.assetAdded);
    },
    onError: (e) => toast.error(e.message),
  });
  const removeAsset = trpc.ems.gridLimits.removeAsset.useMutation({
    onSuccess: invalidate,
    onError: (e) => toast.error(e.message),
  });

  const curtailable = (meters.data ?? []).filter((m) => m.deviceType === "inverter");

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.grid.title}</CardTitle>
        <CardDescription>{t.grid.hint}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-1.5">
          <Label>{t.common.site}</Label>
          <Select
            value={siteId}
            onValueChange={(v) => {
              setSiteId(v);
              const l = (limits.data ?? []).find((x) => x.siteId === Number(v));
              // Load whatever is already configured so saving does not silently
              // wipe a limit the operator could not see.
              setPccMeterId(l ? String(l.pccMeterId) : "");
              setMaxImportKw(l?.maxImportKw != null ? String(l.maxImportKw) : "");
              setMaxExportKw(l?.maxExportKw != null ? String(l.maxExportKw) : "");
            }}
          >
            <SelectTrigger className="max-w-sm">
              <SelectValue placeholder={t.grid.chooseSite} />
            </SelectTrigger>
            <SelectContent>
              {(sites.data ?? []).map((s) => (
                <SelectItem key={s.id} value={String(s.id)}>
                  {s.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {selectedSite !== null && (
          <>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <div className="space-y-1.5">
                <Label>{t.grid.pccMeter}</Label>
                <Select value={pccMeterId} onValueChange={setPccMeterId}>
                  <SelectTrigger>
                    <SelectValue placeholder={t.grid.choosePcc} />
                  </SelectTrigger>
                  <SelectContent>
                    {(meters.data ?? []).map((m) => (
                      <SelectItem key={m.id} value={String(m.id)}>
                        {m.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">{t.grid.pccHint}</p>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="grid-import">{t.grid.maxImport}</Label>
                <Input
                  id="grid-import"
                  type="number"
                  value={maxImportKw}
                  onChange={(e) => setMaxImportKw(e.target.value)}
                  placeholder={t.grid.noLimit}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="grid-export">{t.grid.maxExport}</Label>
                <Input
                  id="grid-export"
                  type="number"
                  value={maxExportKw}
                  onChange={(e) => setMaxExportKw(e.target.value)}
                  placeholder={t.grid.noLimit}
                />
              </div>
              <div className="flex items-end">
                <Button
                  className="w-full"
                  disabled={!canWrite || !pccMeterId || (!maxImportKw && !maxExportKw) || upsert.isPending}
                  onClick={() =>
                    upsert.mutate({
                      siteId: selectedSite,
                      pccMeterId: Number(pccMeterId),
                      maxImportKw: maxImportKw === "" ? null : Number(maxImportKw),
                      maxExportKw: maxExportKw === "" ? null : Number(maxExportKw),
                    })
                  }
                >
                  {upsert.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
                  {t.common.save}
                </Button>
              </div>
            </div>

            {existing && (
              <p className="text-sm text-muted-foreground">
                {t.grid.currentlyCurtailed}: <span className="font-medium text-foreground">{existing.curtailKw} kW</span>
              </p>
            )}

            <div className="space-y-2">
              <h3 className="text-sm font-medium">{t.grid.order}</h3>
              <p className="text-xs text-muted-foreground">{t.grid.orderHint}</p>
              {canWrite && (
                <div className="grid gap-2 sm:grid-cols-4">
                  <Select value={assetMeterId} onValueChange={setAssetMeterId}>
                    <SelectTrigger>
                      <SelectValue placeholder={t.grid.chooseAsset} />
                    </SelectTrigger>
                    <SelectContent>
                      {curtailable.map((m) => (
                        <SelectItem key={m.id} value={String(m.id)}>
                          {m.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    type="number"
                    value={assetRatedKw}
                    onChange={(e) => setAssetRatedKw(e.target.value)}
                    placeholder={t.grid.ratedKw}
                  />
                  <Input
                    type="number"
                    value={assetPriority}
                    onChange={(e) => setAssetPriority(e.target.value)}
                    placeholder={t.grid.priority}
                  />
                  <Button
                    variant="outline"
                    disabled={!assetMeterId || !assetRatedKw || addAsset.isPending}
                    onClick={() =>
                      addAsset.mutate({
                        siteId: selectedSite,
                        meterId: Number(assetMeterId),
                        ratedKw: Number(assetRatedKw),
                        priority: Number(assetPriority) || 100,
                      })
                    }
                  >
                    <Plus className="mr-1 h-4 w-4" /> {t.common.add}
                  </Button>
                </div>
              )}
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t.grid.priority}</TableHead>
                    <TableHead>{t.common.name}</TableHead>
                    <TableHead>{t.common.model}</TableHead>
                    <TableHead className="text-right">{t.grid.ratedKw}</TableHead>
                    {canWrite && <TableHead className="text-right">{t.common.actions}</TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(assets.data ?? []).map((a) => (
                    <TableRow key={a.id}>
                      <TableCell>{a.priority}</TableCell>
                      <TableCell>{a.meterName ?? `#${a.meterId}`}</TableCell>
                      <TableCell className="text-sm text-muted-foreground">{a.model}</TableCell>
                      <TableCell className="text-right">{a.ratedKw}</TableCell>
                      {canWrite && (
                        <TableCell className="text-right">
                          <ConfirmButton
                            title={`${t.grid.removeAsset}: ${a.meterName ?? a.meterId}`}
                            description={t.grid.removeAssetHint}
                            onConfirm={() => removeAsset.mutate({ id: a.id })}
                          />
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                  {(assets.data ?? []).length === 0 && (
                    <TableRow>
                      <TableCell colSpan={canWrite ? 5 : 4} className="text-sm text-muted-foreground">
                        {t.grid.noAssets}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}
