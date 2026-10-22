// §9.10: the commissioning page.
//
// docs/commissioning.md described the procedure well, and that was the whole
// of it: a document. An installer on a roof had no way to see what the
// previous visit had already done, and nobody at the office could tell which
// of thirty sites were half-finished — "did anyone configure the alarms on
// that site?" was answered by opening four screens and guessing.
//
// Every row here is re-derived from the system's own data each time the page
// opens, and none of them can be ticked by hand. A checklist that only records
// opinions is a form; one that checks itself is a tool. The single exception is
// the handover signature, because nothing in a database can attest that a
// person walked the site.
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import type { Dictionary } from "@/i18n/en";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtTime } from "@/components/shared";
import { CheckCircle2, CircleDashed, Loader2, MinusCircle, XCircle } from "lucide-react";
import { toast } from "sonner";

export default function Commissioning() {
  const { t } = useI18n();
  const me = trpc.auth.me.useQuery();
  const canWrite = !me.data?.authRequired || me.data?.user?.role === "admin" || me.data?.user?.role === "operator";
  const utils = trpc.useUtils();
  const sites = trpc.sites.list.useQuery();
  const [siteId, setSiteId] = useState<string>("");
  // The first site is a reasonable default: an installer opening this page is
  // almost always looking at the one they are standing on, and an empty screen
  // with a dropdown is a worse first impression than a filled-in one.
  const effective = siteId || (sites.data?.[0] ? String(sites.data[0].id) : "");

  const check = trpc.sites.commissioning.useQuery(
    { siteId: Number(effective) },
    { enabled: effective !== "", refetchInterval: 30_000 },
  );

  const [signer, setSigner] = useState("");
  const [note, setNote] = useState("");
  const invalidate = () => void utils.sites.commissioning.invalidate();
  const sign = trpc.sites.signCommissioning.useMutation({
    onSuccess: () => {
      invalidate();
      setSigner("");
      setNote("");
      toast.success(t.commissioning.signed);
    },
    onError: (e) => toast.error(e.message),
  });
  const unsign = trpc.sites.unsignCommissioning.useMutation({
    onSuccess: () => {
      invalidate();
      toast.success(t.commissioning.unsigned);
    },
    onError: (e) => toast.error(e.message),
  });

  const data = check.data;
  const icon = (status: string) =>
    status === "pass" ? (
      <CheckCircle2 className="h-4 w-4 text-emerald-600 dark:text-emerald-400" />
    ) : status === "n/a" ? (
      <MinusCircle className="h-4 w-4 text-muted-foreground" />
    ) : status === "pending" ? (
      <CircleDashed className="h-4 w-4 text-amber-600 dark:text-amber-400" />
    ) : (
      <XCircle className="h-4 w-4 text-red-600 dark:text-red-400" />
    );
  const statusLabel = (status: string) =>
    status === "pass"
      ? t.commissioning.statusPass
      : status === "n/a"
        ? t.commissioning.statusNa
        : status === "pending"
          ? t.commissioning.statusPending
          : t.commissioning.statusFail;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t.commissioning.title}</h1>
        <p className="text-sm text-muted-foreground">{t.commissioning.hint}</p>
      </div>

      <div className="max-w-sm space-y-2">
        <Label>{t.commissioning.pickSite}</Label>
        <Select value={effective} onValueChange={setSiteId}>
          <SelectTrigger>
            <SelectValue placeholder={t.commissioning.pickSite} />
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

      {check.isLoading && effective !== "" && (
        <p className="text-sm text-muted-foreground">
          <Loader2 className="mr-1 inline h-4 w-4 animate-spin" />
        </p>
      )}

      {data && (
        <>
          <Card>
            <CardHeader>
              <CardTitle className="flex flex-wrap items-center gap-3">
                {data.siteName}
                <span
                  className={
                    data.summary.complete
                      ? "rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                      : "rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                  }
                >
                  {t.commissioning.progress}: {data.summary.passed}/{data.summary.applicable}
                </span>
              </CardTitle>
              <CardDescription>
                {data.summary.complete ? t.commissioning.complete : t.commissioning.incomplete}{" "}
                {t.commissioning.freshness.replace("{m}", String(Math.round(data.freshnessMs / 60_000)))}
              </CardDescription>
            </CardHeader>
            <CardContent>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-8" />
                    <TableHead>{t.commissioning.step}</TableHead>
                    <TableHead>{t.common.status}</TableHead>
                    <TableHead>{t.commissioning.detail}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.steps.map((s) => (
                    <TableRow key={s.step}>
                      <TableCell>{icon(s.status)}</TableCell>
                      <TableCell className="font-medium">
                        {t.commissioning.steps[s.step as keyof Dictionary["commissioning"]["steps"]] ?? s.step}
                      </TableCell>
                      <TableCell className="text-sm text-muted-foreground">{statusLabel(s.status)}</TableCell>
                      {/* The detail is the evidence — what was checked and what
                          was found — so a failing row is actionable instead of
                          just red. */}
                      <TableCell className="text-sm text-muted-foreground">{s.detail}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t.commissioning.sign}</CardTitle>
              <CardDescription>{t.commissioning.signWarning}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              {data.signoff ? (
                <div className="flex flex-wrap items-center gap-3 text-sm">
                  <span>
                    {t.commissioning.signedBy}: <span className="font-medium">{data.signoff.signedByName}</span>
                  </span>
                  <span className="text-muted-foreground">
                    {t.commissioning.signedAt} {fmtTime(data.signoff.signedAt)}
                  </span>
                  {data.signoff.note && <span className="text-muted-foreground">— {data.signoff.note}</span>}
                  {canWrite && (
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={unsign.isPending}
                      onClick={() => unsign.mutate({ siteId: data.siteId })}
                    >
                      {t.commissioning.unsign}
                    </Button>
                  )}
                </div>
              ) : (
                canWrite && (
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="space-y-1.5">
                      <Label htmlFor="sign-name">{t.commissioning.signedBy}</Label>
                      <Input
                        id="sign-name"
                        className="w-64"
                        placeholder={t.commissioning.signedByPlaceholder}
                        value={signer}
                        onChange={(e) => setSigner(e.target.value)}
                      />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="sign-note">{t.commissioning.note}</Label>
                      <Input
                        id="sign-note"
                        className="w-80"
                        placeholder={t.commissioning.notePlaceholder}
                        value={note}
                        onChange={(e) => setNote(e.target.value)}
                      />
                    </div>
                    <Button
                      disabled={!signer.trim() || sign.isPending}
                      onClick={() =>
                        sign.mutate({
                          siteId: data.siteId,
                          signedByName: signer.trim(),
                          ...(note.trim() ? { note: note.trim() } : {}),
                        })
                      }
                    >
                      {sign.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
                      {t.commissioning.sign}
                    </Button>
                  </div>
                )
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
