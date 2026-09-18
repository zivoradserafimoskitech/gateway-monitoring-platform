// §9.9: fleet firmware rollouts.
//
// Firmware could only be pushed one gateway at a time, so a fleet update meant
// a script looping over every gateway — which is how an installation loses all
// of them at the same moment to a bad image. Firmware is not a setpoint: it
// cannot be rolled back over the air, and a gateway that boots into an image
// which no longer reaches the broker is beyond anything this system can do.
//
// So the screen is built around the one thing that protects a fleet: find out
// on ONE device, then a few, then the rest, and stop the moment a wave fails.
// A halted rollout deliberately offers no "resume" — resuming would push the
// same image again.
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Loader2, Pause, Play, Plus, Rocket } from "lucide-react";
import { toast } from "sonner";

export function FirmwareRolloutCard() {
  const { t } = useI18n();
  const me = trpc.auth.me.useQuery();
  const canWrite = me.data?.user?.role === "admin" || me.data?.user?.role === "operator";
  const utils = trpc.useUtils();
  const releases = trpc.ota.releases.useQuery();
  // A running rollout is a live thing: waves are dispatched by a server sweep,
  // so the table has to refresh itself or it shows a snapshot from whenever
  // the page happened to load.
  const rollouts = trpc.ota.rollouts.useQuery(undefined, { refetchInterval: 10_000 });

  const [model, setModel] = useState("");
  const [version, setVersion] = useState("");
  const [url, setUrl] = useState("");
  const [sha, setSha] = useState("");

  const [releaseId, setReleaseId] = useState("");
  const [name, setName] = useState("");
  const [canary, setCanary] = useState("1");
  const [batch, setBatch] = useState("10");
  const [threshold, setThreshold] = useState("10");
  const [startNow, setStartNow] = useState(false);

  const invalidate = () => {
    void utils.ota.releases.invalidate();
    void utils.ota.rollouts.invalidate();
  };
  const addRelease = trpc.ota.createRelease.useMutation({
    onSuccess: () => {
      invalidate();
      setVersion("");
      setUrl("");
      setSha("");
      toast.success(t.rollout.releaseAdded);
    },
    onError: (e) => toast.error(e.message),
  });
  const createRollout = trpc.ota.createRollout.useMutation({
    onSuccess: () => {
      invalidate();
      setName("");
      toast.success(t.rollout.created);
    },
    onError: (e) => toast.error(e.message),
  });
  const setStatus = trpc.ota.setRolloutStatus.useMutation({
    onSuccess: invalidate,
    onError: (e) => toast.error(e.message),
  });

  const statusLabel = (s: string) =>
    s === "running"
      ? t.rollout.statusRunning
      : s === "paused"
        ? t.rollout.statusPaused
        : s === "halted"
          ? t.rollout.statusHalted
          : s === "completed"
            ? t.rollout.statusCompleted
            : t.rollout.statusDraft;

  const releaseList = releases.data ?? [];
  const rolloutList = rollouts.data ?? [];

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t.rollout.releases}</CardTitle>
          <CardDescription>{t.rollout.releasesHint}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {canWrite && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
              <div className="space-y-1.5">
                <Label htmlFor="fw-model">{t.rollout.model}</Label>
                <Input id="fw-model" value={model} onChange={(e) => setModel(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="fw-version">{t.rollout.version}</Label>
                <Input id="fw-version" value={version} onChange={(e) => setVersion(e.target.value)} />
              </div>
              <div className="space-y-1.5 lg:col-span-2">
                <Label htmlFor="fw-url">{t.rollout.url}</Label>
                <Input id="fw-url" value={url} onChange={(e) => setUrl(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="fw-sha">{t.rollout.sha256}</Label>
                <Input id="fw-sha" value={sha} onChange={(e) => setSha(e.target.value)} />
              </div>
              <div className="flex items-end">
                <Button
                  className="w-full"
                  disabled={!model.trim() || !version.trim() || !url.trim() || addRelease.isPending}
                  onClick={() =>
                    addRelease.mutate({
                      model: model.trim(),
                      version: version.trim(),
                      url: url.trim(),
                      ...(sha.trim() ? { sha256: sha.trim() } : {}),
                    })
                  }
                >
                  {addRelease.isPending ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="mr-1 h-4 w-4" />
                  )}
                  {t.rollout.addRelease}
                </Button>
              </div>
            </div>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.rollout.model}</TableHead>
                <TableHead>{t.rollout.version}</TableHead>
                <TableHead>{t.rollout.url}</TableHead>
                <TableHead>{t.rollout.sha256}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {releaseList.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.model}</TableCell>
                  <TableCell className="font-mono text-xs">{r.version}</TableCell>
                  <TableCell className="max-w-72 truncate font-mono text-xs" title={r.url}>
                    {r.url}
                  </TableCell>
                  <TableCell className="font-mono text-xs text-muted-foreground">
                    {/* Truncated: the point on screen is whether one was
                        recorded, not reading 64 hex characters. */}
                    {r.sha256 ? `${r.sha256.slice(0, 12)}…` : "—"}
                  </TableCell>
                </TableRow>
              ))}
              {releaseList.length === 0 && (
                <TableRow>
                  <TableCell colSpan={4} className="text-sm text-muted-foreground">
                    {t.rollout.noReleases}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Rocket className="h-4 w-4" /> {t.rollout.title}
          </CardTitle>
          <CardDescription>{t.rollout.hint}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {canWrite && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
              <div className="space-y-1.5 lg:col-span-2">
                <Label>{t.rollout.version}</Label>
                <Select value={releaseId} onValueChange={setReleaseId}>
                  <SelectTrigger>
                    <SelectValue placeholder={t.rollout.releases} />
                  </SelectTrigger>
                  <SelectContent>
                    {releaseList.map((r) => (
                      <SelectItem key={r.id} value={String(r.id)}>
                        {r.model} {r.version}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ro-name">{t.rollout.name}</Label>
                <Input id="ro-name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ro-canary">{t.rollout.canary}</Label>
                <Input id="ro-canary" value={canary} onChange={(e) => setCanary(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ro-batch">{t.rollout.batchSize}</Label>
                <Input id="ro-batch" value={batch} onChange={(e) => setBatch(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="ro-threshold">{t.rollout.threshold}</Label>
                <Input id="ro-threshold" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
              </div>
              <div className="flex items-center gap-2 lg:col-span-2">
                <label className="flex items-center gap-2 text-sm">
                  {/* Off by default: a fleet firmware update should be started
                      by somebody who meant to start it, not by filling in a
                      form and pressing the only button on it. */}
                  <Checkbox checked={startNow} onCheckedChange={() => setStartNow((v) => !v)} />
                  {t.rollout.startNow}
                </label>
              </div>
              <div className="flex items-end lg:col-span-2">
                <Button
                  className="w-full"
                  disabled={!releaseId || !name.trim() || createRollout.isPending}
                  onClick={() =>
                    createRollout.mutate({
                      releaseId: Number(releaseId),
                      name: name.trim(),
                      canaryCount: Math.max(1, Number(canary) || 1),
                      batchSize: Math.max(1, Number(batch) || 10),
                      failureThresholdPct: Math.min(100, Math.max(0, Number(threshold) || 0)),
                      start: startNow,
                    })
                  }
                >
                  {createRollout.isPending ? (
                    <Loader2 className="mr-1 h-4 w-4 animate-spin" />
                  ) : (
                    <Plus className="mr-1 h-4 w-4" />
                  )}
                  {t.rollout.create}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground lg:col-span-6">{t.rollout.scopeAll}</p>
            </div>
          )}

          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.common.name}</TableHead>
                <TableHead>{t.rollout.version}</TableHead>
                <TableHead>{t.common.status}</TableHead>
                <TableHead>{t.rollout.progress}</TableHead>
                {canWrite && <TableHead className="text-right">{t.common.actions}</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {rolloutList.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.name}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {r.model} {r.version}
                  </TableCell>
                  <TableCell>
                    <span
                      className={
                        r.status === "halted"
                          ? "rounded-full bg-red-100 px-2 py-0.5 text-xs text-red-700 dark:bg-red-950 dark:text-red-300"
                          : r.status === "completed"
                            ? "rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                            : "rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                      }
                      title={r.haltReason ?? undefined}
                    >
                      {statusLabel(r.status)}
                    </span>
                  </TableCell>
                  <TableCell className="text-sm">
                    <div className="flex items-center gap-2">
                      <div className="h-1.5 w-24 overflow-hidden rounded-full bg-muted">
                        <div
                          className={r.progress.failed > 0 ? "h-full bg-red-500" : "h-full bg-emerald-500"}
                          style={{ width: `${r.progress.percent}%` }}
                        />
                      </div>
                      <span className="text-xs text-muted-foreground">
                        {r.progress.ack}/{r.progress.total}
                        {r.progress.failed > 0 ? ` · ${r.progress.failed} ✕` : ""}
                      </span>
                    </div>
                  </TableCell>
                  {canWrite && (
                    <TableCell className="text-right">
                      {/* No resume for a halted rollout, deliberately. */}
                      {r.status === "running" && (
                        <Button
                          size="sm"
                          variant="outline"
                          disabled={setStatus.isPending}
                          onClick={() => setStatus.mutate({ id: r.id, status: "paused" })}
                        >
                          <Pause className="mr-1 h-3 w-3" />
                          {t.rollout.pause}
                        </Button>
                      )}
                      {(r.status === "draft" || r.status === "paused") && (
                        <Button
                          size="sm"
                          disabled={setStatus.isPending}
                          onClick={() => setStatus.mutate({ id: r.id, status: "running" })}
                        >
                          <Play className="mr-1 h-3 w-3" />
                          {t.rollout.start}
                        </Button>
                      )}
                    </TableCell>
                  )}
                </TableRow>
              ))}
              {rolloutList.length === 0 && (
                <TableRow>
                  <TableCell colSpan={canWrite ? 5 : 4} className="text-sm text-muted-foreground">
                    {t.rollout.noRollouts}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
          {rolloutList.some((r) => r.status === "halted") && (
            <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
              {t.rollout.haltedNote}
            </p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
