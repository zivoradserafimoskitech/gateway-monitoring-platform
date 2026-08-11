// v9.1/B5: active optimizer plan card on MeterDetail — makes the v9 chain
// VISIBLE: which plan the controller is executing right now (or next), who
// pushed it (source), the validity window, the upcoming setpoints, and the
// superseded/expired history. Read-only; plans arrive via REST (Contract A).
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { BrainCircuit } from "lucide-react";

type Setpoint = { ts: string; kw: number };

function kwBadge(kw: number): { text: string; cls: string } {
  if (kw > 0) return { text: `+${kw.toFixed(1)} kW`, cls: "text-amber-600" }; // discharge
  if (kw < 0) return { text: `${kw.toFixed(1)} kW`, cls: "text-emerald-600" }; // charge
  return { text: "0 kW", cls: "text-slate-400" }; // idle
}

export function EmsPlanCard({ meterId }: { meterId: number }) {
  const { t } = useI18n();
  const plans = trpc.ems.plans.useQuery({ meterId, limit: 10 }, { refetchInterval: 15000 });

  const now = Date.now();
  const rows = plans.data ?? [];
  const active = rows.find((p) => p.status === "active" && new Date(p.validFrom).getTime() <= now && new Date(p.validTo).getTime() > now)
    ?? rows.find((p) => p.status === "active" && new Date(p.validFrom).getTime() > now);
  const history = rows.filter((p) => p !== active).slice(0, 5);

  // Current + next few setpoints of the active plan (step function: last ts <= now).
  const setpoints: Setpoint[] = active && Array.isArray(active.setpoints) ? (active.setpoints as Setpoint[]) : [];
  const idx = setpoints.findIndex((s) => new Date(s.ts).getTime() > now);
  const currentIdx = idx === -1 ? setpoints.length - 1 : Math.max(0, idx - 1);
  const upcoming = setpoints.slice(currentIdx, currentIdx + 6);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <BrainCircuit className="h-4 w-4" /> {t.emsPlan.title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {!active && <p className="text-sm text-slate-400">{t.emsPlan.empty}</p>}
        {active && (
          <>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
              <span className="rounded bg-emerald-100 px-1.5 py-0.5 text-xs font-medium text-emerald-800">{t.emsPlan.active}</span>
              <span className="font-mono text-xs">{active.source}</span>
              <span className="text-xs text-slate-500">
                {new Date(active.validFrom).toLocaleString()} → {new Date(active.validTo).toLocaleString()}
              </span>
              <span className="text-xs text-slate-400">#{active.id}</span>
            </div>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t.emsPlan.time}</TableHead>
                  <TableHead>{t.emsPlan.setpoint}</TableHead>
                  <TableHead>{t.emsPlan.mode}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {upcoming.map((s, i) => {
                  const b = kwBadge(s.kw);
                  const isNow = i === 0 && new Date(s.ts).getTime() <= now;
                  return (
                    <TableRow key={s.ts} className={isNow ? "bg-slate-50 font-medium" : ""}>
                      <TableCell className="text-xs">{new Date(s.ts).toLocaleString()}</TableCell>
                      <TableCell className={`font-mono text-xs ${b.cls}`}>{b.text}</TableCell>
                      <TableCell className="text-xs text-slate-500">
                        {s.kw > 0 ? t.emsPlan.discharge : s.kw < 0 ? t.emsPlan.charge : t.emsPlan.idle}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </>
        )}
        {history.length > 0 && (
          <div>
            <h3 className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">{t.emsPlan.history}</h3>
            <div className="space-y-0.5">
              {history.map((p) => (
                <div key={p.id} className="flex items-center gap-3 text-xs text-slate-500">
                  <span className={`rounded px-1.5 py-0.5 ${p.status === "expired" ? "bg-slate-100" : "bg-orange-100 text-orange-700"}`}>{p.status}</span>
                  <span className="font-mono">{p.source}</span>
                  <span>
                    {new Date(p.validFrom).toLocaleString()} → {new Date(p.validTo).toLocaleString()}
                  </span>
                  <span>#{p.id}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
