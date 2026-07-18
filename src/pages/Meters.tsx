import { Link } from "react-router";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { StatusBadge, fmtTime } from "@/components/shared";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export default function Meters() {
  const { t } = useI18n();
  const meters = trpc.meters.list.useQuery(undefined, { refetchInterval: 5000 });

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t.meters.title}</h1>
        <p className="text-sm text-slate-500">{t.meters.subtitle}</p>
      </div>
      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.common.status}</TableHead>
                <TableHead>{t.common.name}</TableHead>
                <TableHead>{t.common.model}</TableHead>
                <TableHead>{t.meters.phases}</TableHead>
                <TableHead>{t.meters.gateway}</TableHead>
                <TableHead>{t.meters.modbusAddress}</TableHead>
                <TableHead>{t.common.site}</TableHead>
                <TableHead>{t.common.lastSeen}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(meters.data ?? []).map((m) => (
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
                  <TableCell>{m.phases === "single" ? t.meters.single : t.meters.three}</TableCell>
                  <TableCell>
                    <Link to={`/gateways/${m.gatewayId}`} className="text-emerald-700 hover:underline">
                      {m.gatewayName}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono">{m.modbusAddress}</TableCell>
                  <TableCell>{m.siteName ?? "—"}</TableCell>
                  <TableCell className="text-xs">{m.lastSeenAt ? fmtTime(m.lastSeenAt) : t.common.never}</TableCell>
                </TableRow>
              ))}
              {(meters.data ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={8} className="py-10 text-center text-sm text-slate-500">
                    {t.common.noData}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
