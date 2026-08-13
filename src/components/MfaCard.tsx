// audit #23: per-user TOTP MFA management card on Settings (same slot as
// ApiKeysCard). Setup wizard: QR scan / manual secret → code confirm → 8
// single-use backup codes shown EXACTLY once (same discipline as API keys).
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { Check, Copy, Loader2, ShieldCheck, ShieldOff } from "lucide-react";
import { toast } from "sonner";

function CodeInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <InputOTP maxLength={6} value={value} onChange={onChange}>
      <InputOTPGroup>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <InputOTPSlot key={i} index={i} />
        ))}
      </InputOTPGroup>
    </InputOTP>
  );
}

function BackupCodesView({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t.mfa.copyFailed);
    }
  };
  return (
    <div className="space-y-3 rounded-md border border-amber-300 bg-amber-50 p-3">
      <p className="text-xs font-medium text-amber-800">{t.mfa.backupHint}</p>
      <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
        {codes.map((c) => (
          <code key={c} className="rounded bg-white px-2 py-1 text-center font-mono text-xs">
            {c}
          </code>
        ))}
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => void copy()}>
          {copied ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
          {t.mfa.copy}
        </Button>
        <Button size="sm" onClick={onDone}>
          {t.mfa.savedDone}
        </Button>
      </div>
    </div>
  );
}

export function MfaCard() {
  const { t } = useI18n();
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const loggedIn = !!me.data?.user;
  const status = trpc.auth.mfaStatus.useQuery(undefined, { enabled: loggedIn });
  // wizard: null (idle) | "setup" | "disable" | "regen"
  const [wizard, setWizard] = useState<null | "setup" | "disable" | "regen">(null);
  const [setup, setSetup] = useState<{ secret: string; qrDataUrl: string } | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [freshCodes, setFreshCodes] = useState<string[] | null>(null);
  const [copiedSecret, setCopiedSecret] = useState(false);

  const invalidate = () => void utils.auth.mfaStatus.invalidate();

  const begin = trpc.auth.mfaSetupBegin.useMutation({
    onSuccess: (d) => {
      setSetup({ secret: d.secret, qrDataUrl: d.qrDataUrl });
      setCode("");
    },
    onError: (e) => toast.error(e.message),
  });
  const confirm = trpc.auth.mfaSetupConfirm.useMutation({
    onSuccess: (d) => {
      setFreshCodes(d.backupCodes); // the ONLY time the raw codes exist
      setWizard(null);
      setSetup(null);
      setCode("");
      invalidate();
      toast.success(t.mfa.enabledToast);
    },
    onError: (e) => toast.error(e.message),
  });
  const disable = trpc.auth.mfaDisable.useMutation({
    onSuccess: () => {
      setWizard(null);
      setCode("");
      setPassword("");
      invalidate();
      toast.success(t.mfa.disabledToast);
    },
    onError: (e) => toast.error(e.message),
  });
  const regen = trpc.auth.mfaRegenerateBackup.useMutation({
    onSuccess: (d) => {
      setFreshCodes(d.backupCodes);
      setWizard(null);
      setCode("");
      invalidate();
      toast.success(t.mfa.regenDone);
    },
    onError: (e) => toast.error(e.message),
  });

  if (!loggedIn) return null;

  const copySecret = async () => {
    if (!setup) return;
    try {
      await navigator.clipboard.writeText(setup.secret);
      setCopiedSecret(true);
      setTimeout(() => setCopiedSecret(false), 1500);
    } catch {
      toast.error(t.mfa.copyFailed);
    }
  };

  const enabled = status.data?.enabled === true;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-4 w-4" /> {t.mfa.title}
          {status.data && (
            <Badge variant={enabled ? "default" : "secondary"}>
              {enabled ? t.mfa.statusEnabled : t.mfa.statusDisabled}
            </Badge>
          )}
          {enabled && status.data && (
            <span className="text-xs font-normal text-slate-500">
              {t.mfa.backupLeft}: {status.data.backupCodesLeft}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {status.data && !status.data.serverConfigured && (
          <p className="text-xs text-amber-700">{t.mfa.serverNotConfigured}</p>
        )}

        {/* idle actions */}
        {!wizard && !freshCodes && (
          <div className="flex flex-wrap gap-2">
            {!enabled ? (
              <Button
                size="sm"
                disabled={begin.isPending || status.data?.serverConfigured === false}
                onClick={() => {
                  setWizard("setup");
                  setSetup(null);
                  begin.mutate();
                }}
              >
                {begin.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <ShieldCheck className="h-3 w-3" />}
                {t.mfa.enable}
              </Button>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => {
                    setWizard("regen");
                    setCode("");
                  }}
                >
                  {t.mfa.regen}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={() => {
                    setWizard("disable");
                    setCode("");
                    setPassword("");
                  }}
                >
                  <ShieldOff className="h-3 w-3" /> {t.mfa.disable}
                </Button>
              </>
            )}
          </div>
        )}

        {/* setup wizard: QR + manual secret + code confirm */}
        {wizard === "setup" && (
          <div className="space-y-3 rounded-md border p-3">
            {!setup ? (
              <Loader2 className="h-4 w-4 animate-spin text-slate-400" />
            ) : (
              <>
                <p className="text-sm text-slate-600">{t.mfa.setupScan}</p>
                <img src={setup.qrDataUrl} alt="MFA QR" className="h-40 w-40 rounded border bg-white" />
                <div className="space-y-1">
                  <Label className="text-xs">{t.mfa.manualSecret}</Label>
                  <div className="flex items-center gap-2">
                    <code className="break-all rounded bg-slate-100 px-2 py-1 font-mono text-xs">{setup.secret}</code>
                    <Button size="sm" variant="ghost" onClick={() => void copySecret()}>
                      {copiedSecret ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
                    </Button>
                  </div>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">{t.mfa.codeLabel}</Label>
                  <CodeInput value={code} onChange={setCode} />
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    disabled={code.length !== 6 || confirm.isPending}
                    onClick={() => confirm.mutate({ code })}
                  >
                    {confirm.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
                    {t.mfa.confirmEnable}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setWizard(null)}>
                    {t.common.cancel}
                  </Button>
                </div>
              </>
            )}
          </div>
        )}

        {/* regenerate backup codes: needs a current TOTP code */}
        {wizard === "regen" && (
          <div className="space-y-3 rounded-md border p-3">
            <p className="text-sm text-slate-600">{t.mfa.regenHint}</p>
            <CodeInput value={code} onChange={setCode} />
            <div className="flex gap-2">
              <Button size="sm" disabled={code.length !== 6 || regen.isPending} onClick={() => regen.mutate({ code })}>
                {regen.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
                {t.mfa.regen}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setWizard(null)}>
                {t.common.cancel}
              </Button>
            </div>
          </div>
        )}

        {/* disable: password + TOTP code */}
        {wizard === "disable" && (
          <div className="space-y-3 rounded-md border p-3">
            <p className="text-sm text-slate-600">{t.mfa.disableHint}</p>
            <div className="space-y-1">
              <Label className="text-xs">{t.mfa.passwordLabel}</Label>
              <Input
                type="password"
                autoComplete="current-password"
                className="max-w-64"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            <CodeInput value={code} onChange={setCode} />
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="destructive"
                disabled={!password || code.length !== 6 || disable.isPending}
                onClick={() => disable.mutate({ password, code })}
              >
                {disable.isPending && <Loader2 className="h-3 w-3 animate-spin" />}
                {t.mfa.disable}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setWizard(null)}>
                {t.common.cancel}
              </Button>
            </div>
          </div>
        )}

        {/* backup codes — shown ONCE after setup / regeneration */}
        {freshCodes && (
          <BackupCodesView
            codes={freshCodes}
            onDone={() => {
              setFreshCodes(null);
              invalidate();
            }}
          />
        )}
      </CardContent>
    </Card>
  );
}
