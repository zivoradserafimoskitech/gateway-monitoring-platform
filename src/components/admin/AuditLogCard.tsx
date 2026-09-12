// §8: auth.auditLog had no screen, so the trail that makes control actions
// attributable could only be read with SQL. Admin-gated and org-scoped
// server-side: an org admin sees their own tenant's trail, a superadmin all.
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtTime } from "@/components/shared";

export function AuditLogCard() {
  const { t } = useI18n();
  const [limit, setLimit] = useState("100");
  const [filter, setFilter] = useState("");
  const log = trpc.auth.auditLog.useQuery({ limit: Number(limit) });

  const needle = filter.trim().toLowerCase();
  const rows = (log.data ?? []).filter(
    (r) =>
      !needle ||
      r.procedure.toLowerCase().includes(needle) ||
      (r.email ?? "").toLowerCase().includes(needle) ||
      (r.summary ?? "").toLowerCase().includes(needle),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.admin.auditTitle}</CardTitle>
        <CardDescription>{t.admin.auditHint}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-2">
          <Input
            className="max-w-xs"
            placeholder={t.admin.auditFilter}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <Select value={limit} onValueChange={setLimit}>
            <SelectTrigger className="w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {["50", "100", "200", "500"].map((n) => (
                <SelectItem key={n} value={n}>
                  {n} {t.admin.rows}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.admin.when}</TableHead>
              <TableHead>{t.admin.who}</TableHead>
              <TableHead>{t.admin.action}</TableHead>
              <TableHead>{t.admin.summary}</TableHead>
              <TableHead>{t.admin.source}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="whitespace-nowrap text-sm text-slate-500">{fmtTime(r.createdAt)}</TableCell>
                <TableCell className="text-sm">{r.email ?? "—"}</TableCell>
                <TableCell className="font-mono text-xs">{r.procedure}</TableCell>
                <TableCell className="max-w-md truncate text-sm text-slate-600" title={r.summary ?? ""}>
                  {r.summary ?? "—"}
                </TableCell>
                <TableCell className="text-xs text-slate-500">
                  {r.ip ?? "—"}
                  {r.userAgent ? <div className="max-w-48 truncate" title={r.userAgent}>{r.userAgent}</div> : null}
                </TableCell>
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-sm text-slate-500">
                  {t.common.noData}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
