// Wave 5 / T3: bench verification wizard — Settings → Device profiles → Verify.
// The guided path that turns a draft profile into bench_verified:
//   1. Read verification   — poll every key, flag range/scaling anomalies
//   2. Sign convention     — command 5% discharge (via the EXISTING gated
//                            control path — the commissioning override must be
//                            on for a draft profile), record whether
//                            batteryPowerKw reads positive or negative
//   3. Control round-trip  — write+read-back per writable key, raw vs scaled
//   4. Range confirmation  — min/max = nameplate, not the register range
// Completion is ADMIN-ONLY and clears the commissioning override.
import { useMemo, useState } from "react";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ClipboardCheck, RefreshCw } from "lucide-react";
import { toast } from "sonner";

interface ControllableDef {
  address: number;
  fc?: 6 | 16;
  min: number;
  max: number;
  scale?: number;
  unit?: string;
  description?: string;
}
type ControllableMap = Record<string, ControllableDef>;

interface ReadRow {
  key: string;
  label: string;
  unit: string;
  min?: number;
  max?: number;
  raw?: number;
  value?: number;
  error?: string;
  inRange: boolean | null;
  flags: string[];
}

const isPowerKey = (key: string, unit?: string): boolean => /power/i.test(key) || unit === "kW" || unit === "W";

export function ProfileVerifyWizard({
  id,
  model,
  label,
  verificationStatus,
  allowUnverifiedControl,
  dischargePositive,
  controllable,
}: {
  id: number;
  model: string;
  label: string;
  verificationStatus: "draft" | "bench_verified" | "field_verified";
  allowUnverifiedControl: boolean;
  dischargePositive: boolean | null;
  controllable: ControllableMap | null;
}) {
  const { t } = useI18n();
  const s = t.settings;
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const isAdmin = !me.data?.user || me.data.user.role === "admin"; // logged-out demo mode = unrestricted

  const [open, setOpen] = useState(false);
  const [deviceId, setDeviceId] = useState<number | null>(null);
  // Wizard progress — read/range confirmations and round-trip results are
  // bench-session state; the sign convention is persisted on the profile.
  const [readRows, setReadRows] = useState<ReadRow[] | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [readConfirmed, setReadConfirmed] = useState(false);
  const [signRecorded, setSignRecorded] = useState<boolean | null>(dischargePositive);
  const [roundTripsOk, setRoundTripsOk] = useState<string[]>([]);
  const [roundTripResults, setRoundTripResults] = useState<Record<string, { status: string; detail: string; expectedRaw: number; raw?: number; scaled?: number }>>({});
  const [roundTripValues, setRoundTripValues] = useState<Record<string, string>>({});
  const [rangeConfirmed, setRangeConfirmed] = useState<Record<string, boolean>>({});
  const [firmware, setFirmware] = useState("");
  const [serial, setSerial] = useState("");
  const [testedNotes, setTestedNotes] = useState("");

  const meters = trpc.meters.list.useQuery(undefined, { enabled: open });
  const candidates = useMemo(
    () => (meters.data ?? []).filter((m) => m.model === model),
    [meters.data, model],
  );

  const writableKeys = Object.keys(controllable ?? {});
  const powerSetpointKey = writableKeys.find((k) => isPowerKey(k, controllable?.[k]?.unit));
  const needsSign = !!powerSetpointKey;
  const nameplateMax = powerSetpointKey ? Math.max(Math.abs(controllable![powerSetpointKey].min), Math.abs(controllable![powerSetpointKey].max)) : 0;

  // Step gating (mirrors api/profile-import/verify.ts benchStepStates):
  const readDone = readConfirmed;
  const signDone = !needsSign || signRecorded !== null;
  const controlDone = writableKeys.every((k) => roundTripsOk.includes(k));
  const rangeDone = writableKeys.length === 0 || writableKeys.every((k) => rangeConfirmed[k]);
  const completable = readDone && signDone && controlDone && rangeDone;

  const verifyRead = trpc.profiles.verifyRead.useMutation({
    onSuccess: (res) => {
      setReadRows(res.rows as ReadRow[]);
      setReadError(res.error ?? null);
      setReadConfirmed(false); // fresh data → confirm again
    },
    onError: (e) => toast.error(e.message),
  });
  const verifySign = trpc.profiles.verifySign.useMutation({
    onSuccess: (_r, v) => {
      setSignRecorded(v.dischargePositive);
      utils.profiles.list.invalidate();
      toast.success(s.verifySignRecorded);
    },
    onError: (e) => toast.error(e.message),
  });
  const setOverride = trpc.profiles.updateVerification.useMutation({
    onSuccess: () => utils.profiles.list.invalidate(),
    onError: (e) => toast.error(e.message),
  });
  const discharge = trpc.control.execute.useMutation({
    onError: (e) => toast.error(e.message),
  });
  const roundTrip = trpc.profiles.verifyControlRoundTrip.useMutation({
    onSuccess: (res) => {
      setRoundTripResults((r) => ({
        ...r,
        [res.key]: { status: res.status, detail: res.detail, expectedRaw: res.expectedRaw, raw: res.readBack.raw, scaled: res.readBack.value },
      }));
      if (res.status === "ok" || res.status === "sent") {
        setRoundTripsOk((ks) => (ks.includes(res.key) ? ks : [...ks, res.key]));
      }
    },
    onError: (e) => toast.error(e.message),
  });
  const complete = trpc.profiles.completeBenchVerification.useMutation({
    onSuccess: () => {
      utils.profiles.list.invalidate(); // badge flips to bench_verified
      toast.success(s.verifyCompleteSuccess);
      setOpen(false);
    },
    onError: (e) => toast.error(e.message),
  });

  const flagLabel = (f: string): string =>
    f === "out_of_range"
      ? s.verifyFlagOutOfRange
      : f === "implausible_soc"
        ? s.verifyFlagImplausibleSoc
        : f === "implausible_voltage"
          ? s.verifyFlagImplausibleVoltage
          : s.verifyFlagBeyondNameplate;

  const stepClass = (available: boolean, done: boolean) =>
    "rounded-md border p-3 space-y-2 " + (done ? "border-emerald-300 bg-emerald-50/50" : available ? "border-slate-200" : "border-slate-100 opacity-60 pointer-events-none");

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <ClipboardCheck className="h-4 w-4" /> {s.verifyButton}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>
            {s.verifyTitle} — {model} <span className="text-sm font-normal text-slate-500">({label})</span>
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-2">
          <Label>{s.verifyDevice}</Label>
          {candidates.length === 0 && meters.data ? (
            <p className="text-sm text-amber-600">{s.verifyNoDevice}</p>
          ) : (
            <Select value={deviceId != null ? String(deviceId) : ""} onValueChange={(v) => setDeviceId(Number(v))}>
              <SelectTrigger className="w-full sm:w-96">
                <SelectValue placeholder={s.verifyDevice} />
              </SelectTrigger>
              <SelectContent>
                {candidates.map((m) => (
                  <SelectItem key={m.id} value={String(m.id)}>
                    {m.name ?? `${m.model} #${m.id}`}
                    {m.siteName ? ` — ${m.siteName}` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {/* Step 1 — read verification */}
        <div className={stepClass(true, readDone)}>
          <p className="text-sm font-semibold">{s.verifyStepRead}</p>
          <p className="text-xs text-slate-500">{s.verifyReadHint}</p>
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            disabled={deviceId == null || verifyRead.isPending}
            onClick={() => deviceId != null && verifyRead.mutate({ profileId: id, deviceId })}
          >
            <RefreshCw className={"h-4 w-4 " + (verifyRead.isPending ? "animate-spin" : "")} /> {s.verifyPoll}
          </Button>
          {readError && <p className="text-sm text-red-600">{readError}</p>}
          {readRows && (
            <>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{s.field}</TableHead>
                    <TableHead className="w-24">{s.verifyRaw}</TableHead>
                    <TableHead className="w-28">{s.verifyScaled}</TableHead>
                    <TableHead className="w-32">{s.verifyColExpected}</TableHead>
                    <TableHead>{s.verifyFlags}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {readRows.map((r) => (
                    <TableRow key={r.key}>
                      <TableCell className="text-sm">
                        {r.label} <span className="ml-1 font-mono text-xs text-slate-400">({r.key})</span>
                      </TableCell>
                      <TableCell className="font-mono text-xs">{r.error ? "—" : (r.raw ?? "—")}</TableCell>
                      <TableCell className="font-mono text-xs">
                        {r.error ? <span className="text-red-600">{r.error}</span> : `${r.value ?? "—"} ${r.unit}`}
                      </TableCell>
                      <TableCell className="font-mono text-xs text-slate-500">
                        {r.min !== undefined || r.max !== undefined ? `[${r.min ?? "−∞"}..${r.max ?? "+∞"}]` : "—"}
                      </TableCell>
                      <TableCell>
                        {r.flags.map((f) => (
                          <span key={f} className="mr-1 rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-medium text-amber-800">
                            {flagLabel(f)}
                          </span>
                        ))}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={readConfirmed} onCheckedChange={(v) => setReadConfirmed(v === true)} />
                {s.verifyConfirmRead}
              </label>
            </>
          )}
        </div>

        {/* Step 2 — sign convention */}
        <div className={stepClass(readDone, signDone)}>
          <p className="text-sm font-semibold">{s.verifyStepSign}</p>
          {needsSign ? (
            <>
              <p className="text-xs text-slate-500">{s.verifySignHint}</p>
              <div className="flex flex-wrap items-center gap-2">
                {isAdmin &&
                  (allowUnverifiedControl ? (
                    <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold uppercase text-amber-800">
                      ⚠ {s.commissioningOverride}
                    </span>
                  ) : (
                    <Button variant="outline" size="sm" disabled={setOverride.isPending} onClick={() => setOverride.mutate({ id, allowUnverifiedControl: true })}>
                      {s.verifyEnableOverride}
                    </Button>
                  ))}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={deviceId == null || !allowUnverifiedControl || discharge.isPending}
                  onClick={() =>
                    deviceId != null &&
                    powerSetpointKey &&
                    discharge.mutate({ meterId: deviceId, key: powerSetpointKey, value: Math.round(nameplateMax * 0.05 * 100) / 100 })
                  }
                >
                  {s.verifyCommandDischarge} ({powerSetpointKey} = {Math.round(nameplateMax * 0.05 * 100) / 100} {controllable?.[powerSetpointKey!]?.unit ?? ""})
                </Button>
                {discharge.data && <span className="text-xs text-slate-500">{discharge.data.detail}</span>}
              </div>
              <p className="text-sm font-medium">{s.verifySignQuestion}</p>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant={signRecorded === true ? "default" : "outline"}
                  disabled={deviceId == null || verifySign.isPending}
                  onClick={() => deviceId != null && verifySign.mutate({ profileId: id, deviceId, dischargePositive: true })}
                >
                  {s.verifyPositive}
                </Button>
                <Button
                  size="sm"
                  variant={signRecorded === false ? "default" : "outline"}
                  disabled={deviceId == null || verifySign.isPending}
                  onClick={() => deviceId != null && verifySign.mutate({ profileId: id, deviceId, dischargePositive: false })}
                >
                  {s.verifyNegative}
                </Button>
                {signRecorded !== null && <span className="text-xs text-emerald-700">✓ {s.verifySignRecorded}</span>}
              </div>
            </>
          ) : (
            <p className="text-xs text-slate-500">{s.verifySignNotNeeded}</p>
          )}
        </div>

        {/* Step 3 — control round-trip */}
        <div className={stepClass(readDone && signDone, controlDone)}>
          <p className="text-sm font-semibold">{s.verifyStepControl}</p>
          <p className="text-xs text-slate-500">{s.verifyControlHint}</p>
          {writableKeys.map((k) => {
            const def = controllable![k];
            const res = roundTripResults[k];
            const done = roundTripsOk.includes(k);
            return (
              <div key={k} className="rounded border border-slate-100 p-2">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs font-semibold">{k}</span>
                  <span className="text-xs text-slate-500">
                    [{def.min}..{def.max}] {def.unit ?? ""} {def.description ? `— ${def.description}` : ""}
                  </span>
                  <Input
                    type="number"
                    step="any"
                    className="h-8 w-28 font-mono"
                    value={roundTripValues[k] ?? String(def.min <= 0 && def.max >= 0 ? 0 : def.min)}
                    onChange={(e) => setRoundTripValues((v) => ({ ...v, [k]: e.target.value }))}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={deviceId == null || roundTrip.isPending}
                    onClick={() =>
                      deviceId != null &&
                      roundTrip.mutate({ profileId: id, deviceId, key: k, value: Number(roundTripValues[k] ?? (def.min <= 0 && def.max >= 0 ? 0 : def.min)) })
                    }
                  >
                    {s.verifyWriteReadback}
                  </Button>
                  {done && <span className="text-xs text-emerald-700">✓</span>}
                </div>
                {res && (
                  <p className={"mt-1 text-xs " + (res.status === "failed" ? "text-red-600" : "text-slate-600")}>
                    {res.detail}
                    <span className="ml-2 font-mono">
                      {s.verifyRaw}={res.raw ?? res.expectedRaw} · {s.verifyScaled}={res.scaled ?? "—"}
                    </span>
                  </p>
                )}
              </div>
            );
          })}
        </div>

        {/* Step 4 — range confirmation */}
        <div className={stepClass(readDone && signDone && controlDone, rangeDone)}>
          <p className="text-sm font-semibold">{s.verifyStepRange}</p>
          <p className="text-xs text-slate-500">{s.verifyRangeHint}</p>
          {writableKeys.map((k) => {
            const def = controllable![k];
            return (
              <label key={k} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={rangeConfirmed[k] === true}
                  onCheckedChange={(v) => setRangeConfirmed((r) => ({ ...r, [k]: v === true }))}
                />
                <span className="font-mono text-xs">{k}</span>
                <span className="text-xs text-slate-500">
                  [{def.min}..{def.max}] {def.unit ?? ""} {s.verifyRangeConfirm}
                </span>
              </label>
            );
          })}
        </div>

        {/* Completion — admin only */}
        {verificationStatus !== "bench_verified" && (
          <div className={"rounded-md border p-3 space-y-2 " + (completable ? "border-sky-300" : "border-slate-100 opacity-60")}>
            <p className="text-sm font-semibold">{s.verifyComplete}</p>
            {!isAdmin && <p className="text-xs text-amber-600">{s.verifyCompleteAdminHint}</p>}
            <div className="grid gap-2 sm:grid-cols-2">
              <div>
                <Label>{s.verifyFirmware}</Label>
                <Input value={firmware} onChange={(e) => setFirmware(e.target.value)} />
              </div>
              <div>
                <Label>{s.verifySerial}</Label>
                <Input value={serial} onChange={(e) => setSerial(e.target.value)} />
              </div>
            </div>
            <div>
              <Label>{s.verifyTestedNotes}</Label>
              <Textarea rows={2} value={testedNotes} onChange={(e) => setTestedNotes(e.target.value)} />
            </div>
            <Button
              size="sm"
              disabled={!completable || !isAdmin || complete.isPending}
              onClick={() => complete.mutate({ profileId: id, firmwareVersion: firmware, serial, testedNotes })}
            >
              {s.verifyComplete}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
