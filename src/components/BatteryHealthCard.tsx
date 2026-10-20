// §9.5: battery state of health and cycle counting.
//
// A BESS is the most expensive thing on most of these sites and the only one
// that wears out by being used. Warranties are written in equivalent full
// cycles and in retained capacity, and before this the platform could report
// neither — it knew a battery's SoC at any instant and nothing about how much
// life had been taken out of it.
//
// The nameplate is the one figure a human has to supply: it is a fact about
// the hardware, not something telemetry can reveal, and everything else here
// is a ratio against it. So a battery without one shows cycles and throughput
// (which need no nameplate) and says plainly that health is unavailable,
// rather than showing a confident percentage computed from a guess.
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtTime } from "@/components/shared";
import { BatteryCharging, Loader2 } from "lucide-react";
import { toast } from "sonner";

const n1 = (v: number | null | undefined, digits = 1): string =>
  v === null || v === undefined ? "—" : v.toFixed(digits);

export function BatteryHealthCard() {
  const { t } = useI18n();
  const me = trpc.auth.me.useQuery();
  const canWrite = me.data?.user?.role === "admin" || me.data?.user?.role === "operator";
  const utils = trpc.useUtils();
  const health = trpc.ems.health.list.useQuery();
  const [draft, setDraft] = useState<Record<number, string>>({});
  const [openFor, setOpenFor] = useState<number | null>(null);

  const save = trpc.ems.health.setNameplate.useMutation({
    onSuccess: () => {
      void utils.ems.health.list.invalidate();
      toast.success(t.soh.nameplateSaved);
    },
    onError: (e) => toast.error(e.message),
  });
  const estimates = trpc.ems.health.estimates.useQuery(
    { meterId: openFor ?? 0, limit: 20 },
    { enabled: openFor !== null },
  );

  const rows = health.data ?? [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <BatteryCharging className="h-4 w-4" /> {t.soh.title}
          </CardTitle>
          <CardDescription>{t.soh.hint}</CardDescription>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.soh.device}</TableHead>
                <TableHead title={t.soh.nameplateHint}>{t.soh.nameplate}</TableHead>
                <TableHead title={t.soh.efcHint}>{t.soh.efc}</TableHead>
                <TableHead>{t.soh.throughput}</TableHead>
                <TableHead>{t.soh.sohPct}</TableHead>
                <TableHead>{t.soh.lastEstimate}</TableHead>
                <TableHead className="text-right">{t.common.actions}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const raw = draft[r.meterId] ?? (r.nameplateKwh === null ? "" : String(r.nameplateKwh));
                const parsed = raw.trim() === "" ? null : Number(raw);
                const valid = parsed === null || (Number.isFinite(parsed) && parsed > 0);
                // Above nameplate is not an error to hide: it is the signal
                // that the nameplate is wrong or the power sign is inverted.
                const over = r.sohPct !== null && r.sohPct > 100;
                return (
                  <TableRow key={r.meterId}>
                    <TableCell className="font-medium">{r.meterName}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1.5">
                        <Input
                          className="h-8 w-24"
                          value={raw}
                          disabled={!canWrite}
                          placeholder={t.soh.noNameplate}
                          onChange={(e) => setDraft((d) => ({ ...d, [r.meterId]: e.target.value }))}
                        />
                        {canWrite && (
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={!valid || save.isPending}
                            onClick={() => save.mutate({ meterId: r.meterId, nameplateKwh: parsed })}
                          >
                            {save.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : t.common.save}
                          </Button>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm">{n1(r.efc, 2)}</TableCell>
                    <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                      {n1(r.throughputDischargedKwh, 0)} / {n1(r.throughputChargedKwh, 0)} kWh
                    </TableCell>
                    <TableCell>
                      {r.nameplateKwh === null ? (
                        <span className="text-xs text-muted-foreground">{t.soh.noNameplate}</span>
                      ) : r.sohPct === null ? (
                        <span className="text-xs text-muted-foreground" title={t.soh.pendingHint}>
                          {t.soh.pending}
                        </span>
                      ) : (
                        <span
                          className={
                            over
                              ? "rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200"
                              : r.sohPct < 80
                                ? "rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700 dark:bg-red-950 dark:text-red-300"
                                : "rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                          }
                          title={over ? t.soh.overCapacity : `${r.sohSamples} ${t.soh.samples}`}
                        >
                          {n1(r.sohPct)}%
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-xs">
                      {r.lastEstimateAt ? fmtTime(r.lastEstimateAt) : "—"}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setOpenFor((cur) => (cur === r.meterId ? null : r.meterId))}
                      >
                        {t.soh.samples}
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
              {rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-sm text-muted-foreground">
                    {t.soh.empty}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {openFor !== null && (
        <Card>
          <CardHeader>
            <CardTitle>{t.soh.estimatesTitle}</CardTitle>
            <CardDescription>{t.soh.estimatesHint}</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.soh.lastEstimate}</TableHead>
                  <TableHead>{t.soh.socRange}</TableHead>
                  <TableHead>{t.soh.dischargedKwh}</TableHead>
                  <TableHead>{t.soh.estimatedKwh}</TableHead>
                  <TableHead>{t.soh.sohPct}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {(estimates.data ?? []).map((e) => (
                  <TableRow key={e.id}>
                    <TableCell className="whitespace-nowrap text-xs">{fmtTime(e.endedAt)}</TableCell>
                    <TableCell className="text-sm">
                      {n1(e.socStart, 0)}% → {n1(e.socEnd, 0)}%
                    </TableCell>
                    <TableCell className="text-sm">{n1(e.dischargedKwh, 1)} kWh</TableCell>
                    <TableCell className="text-sm">{n1(e.estimatedKwh, 1)} kWh</TableCell>
                    <TableCell className="text-sm">{n1(e.sohPct)}%</TableCell>
                  </TableRow>
                ))}
                {(estimates.data ?? []).length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-sm text-muted-foreground">
                      {t.soh.noEstimates}
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
