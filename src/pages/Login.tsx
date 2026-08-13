// v7/C1: login page — email/password, sets the httpOnly session cookie.
// audit #23: 2-step flow — when the account has TOTP MFA enabled, login
// answers { mfaRequired, pendingToken } (NO session) and a code step follows:
// 6-digit TOTP (input-otp) or a single-use backup code (xxxx-xxxx).
import { useState } from "react";
import { trpc, setSessionToken } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp";
import { toast } from "sonner";
import { ShieldCheck, Zap } from "lucide-react";

export default function Login() {
  const { t } = useI18n();
  const utils = trpc.useUtils();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  // Step 2 state (only set when the server demands an MFA code).
  const [pendingToken, setPendingToken] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [useBackup, setUseBackup] = useState(false);
  const [backupCode, setBackupCode] = useState("");

  const onLoggedIn = (token?: string) => {
    if (token) setSessionToken(token);
    utils.auth.me.invalidate();
    utils.invalidate();
  };

  const login = trpc.auth.login.useMutation({
    onSuccess: (data) => {
      if (data.mfaRequired) {
        setPendingToken(data.pendingToken);
        setCode("");
        setBackupCode("");
        setUseBackup(false);
        return; // NO session yet — step 2
      }
      onLoggedIn(data.token);
    },
    onError: (e) => toast.error(e.message),
  });

  const loginMfa = trpc.auth.loginMfa.useMutation({
    onSuccess: (data) => onLoggedIn(data.token),
    onError: (e) => {
      toast.error(e.message);
      // Challenge expired/destroyed → back to the password step.
      if (/sign in again/i.test(e.message)) {
        setPendingToken(null);
        setCode("");
        setBackupCode("");
      }
    },
  });

  if (pendingToken) {
    const activeCode = useBackup ? backupCode.trim() : code;
    const ready = useBackup ? /^[0-9a-f]{4}-[0-9a-f]{4}$/i.test(activeCode) : activeCode.length === 6;
    const submit = () => {
      if (ready && !loginMfa.isPending) loginMfa.mutate({ pendingToken, code: activeCode });
    };
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50">
        <div className="w-full max-w-sm space-y-6 rounded-xl border bg-white p-8 shadow-sm">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-6 w-6 text-amber-500" />
            <h1 className="text-xl font-semibold">{t.mfa.loginTitle}</h1>
          </div>
          <p className="text-sm text-slate-500">
            {useBackup ? t.mfa.loginBackupHint : t.mfa.loginHint}
          </p>
          {useBackup ? (
            <div className="space-y-1.5">
              <Label>{t.mfa.backupCodeLabel}</Label>
              <Input
                className="font-mono"
                autoComplete="one-time-code"
                placeholder="xxxx-xxxx"
                value={backupCode}
                onChange={(e) => setBackupCode(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") submit();
                }}
              />
            </div>
          ) : (
            <div className="flex justify-center">
              <InputOTP
                maxLength={6}
                value={code}
                onChange={setCode}
                onComplete={(v) => {
                  if (!loginMfa.isPending) loginMfa.mutate({ pendingToken, code: v });
                }}
              >
                <InputOTPGroup>
                  {[0, 1, 2, 3, 4, 5].map((i) => (
                    <InputOTPSlot key={i} index={i} />
                  ))}
                </InputOTPGroup>
              </InputOTP>
            </div>
          )}
          <Button className="w-full" disabled={!ready || loginMfa.isPending} onClick={submit}>
            {t.mfa.verify}
          </Button>
          <div className="flex items-center justify-between text-sm">
            <button
              type="button"
              className="text-amber-600 hover:underline"
              onClick={() => setUseBackup((v) => !v)}
            >
              {useBackup ? t.mfa.useTotpInstead : t.mfa.useBackupInstead}
            </button>
            <button
              type="button"
              className="text-slate-400 hover:underline"
              onClick={() => {
                setPendingToken(null);
                setCode("");
                setBackupCode("");
              }}
            >
              {t.common.cancel}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50">
      <div className="w-full max-w-sm space-y-6 rounded-xl border bg-white p-8 shadow-sm">
        <div className="flex items-center gap-2">
          <Zap className="h-6 w-6 text-amber-500" />
          <h1 className="text-xl font-semibold">VoltTrade Cloud</h1>
        </div>
        <div className="space-y-1.5">
          <Label>{t.auth.email}</Label>
          <Input
            type="email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="admin@enertrek.local"
          />
        </div>
        <div className="space-y-1.5">
          <Label>{t.auth.password}</Label>
          <Input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && email && password && !login.isPending) {
                login.mutate({ email, password });
              }
            }}
          />
        </div>
        <Button
          className="w-full"
          disabled={!email || !password || login.isPending}
          onClick={() => login.mutate({ email, password })}
        >
          {t.auth.signIn}
        </Button>
      </div>
    </div>
  );
}
