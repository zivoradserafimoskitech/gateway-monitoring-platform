import { useMemo, useState } from "react";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)} %`);
const DAYS = [1, 7, 30] as const;

/** Technical KPIs of one device over the last N days. */
export function KpiCard({ meterId }: { meterId: number }) {
  const { t } = useI18n();
  const [days, setDays] = useState<(typeof DAYS)[number]>(7);
  const range = useMemo(() => {
    const to = new Date();
    return { from: new Date(to.getTime() - days * 86_400_000), to };
  }, [days]);
  const q = trpc.kpis.device.useQuery({ meterId, ...range });
  const k = q.data;
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle>{t.kpis.title}</CardTitle>
        <div className="flex gap-1">
          {DAYS.map((d) => (
            <Button key={d} size="sm" variant={d === days ? "default" : "outline"} onClick={() => setDays(d)}>
              {d} {t.kpis.days}
            </Button>
          ))}
        </div>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-3">
        <div><div className="text-xs text-muted-foreground">{t.kpis.availability}</div><div className="text-xl font-semibold">{pct(k?.availability ?? null)}</div></div>
        <div><div className="text-xs text-muted-foreground">{t.kpis.completeness}</div><div className="text-xl font-semibold">{pct(k?.dataCompleteness ?? null)}</div></div>
        <div>
          <div className="text-xs text-muted-foreground">{t.kpis.performanceRatio}</div>
          <div className="text-xl font-semibold">{pct(k?.performanceRatio ?? null)}</div>
          {k && k.performanceRatio === null && <div className="text-xs text-muted-foreground">{t.kpis.prHint}</div>}
        </div>
      </CardContent>
    </Card>
  );
}
