// v7/C1: login page — email/password, sets the httpOnly session cookie.
import { useState } from "react";
import { trpc, setSessionToken } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";
import { Zap } from "lucide-react";

export default function Login() {
  const { t } = useI18n();
  const utils = trpc.useUtils();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const login = trpc.auth.login.useMutation({
    onSuccess: (data) => {
      if (data.token) setSessionToken(data.token);
      utils.auth.me.invalidate();
      utils.invalidate();
    },
    onError: (e) => toast.error(e.message),
  });

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
