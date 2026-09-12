// §8: auth.changePassword existed on the backend — with the right behaviour of
// killing every OTHER session of the user — but no screen called it, so a user
// who suspected their password was known could do nothing about it.
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

export function ChangePasswordCard() {
  const { t } = useI18n();
  const me = trpc.auth.me.useQuery();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const change = trpc.auth.changePassword.useMutation({
    onSuccess: () => {
      setCurrent("");
      setNext("");
      setConfirm("");
      toast.success(t.admin.passwordChanged);
    },
    onError: (e) => toast.error(e.message),
  });

  // Nothing to change in demo mode: there is no account behind the session.
  if (!me.data?.user) return null;

  const mismatch = confirm.length > 0 && next !== confirm;
  const ready = current.length > 0 && next.length >= 8 && next === confirm;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.admin.changePassword}</CardTitle>
        <CardDescription>{t.admin.changePasswordHint}</CardDescription>
      </CardHeader>
      <CardContent className="max-w-sm space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor="current-password">{t.mfa.passwordLabel}</Label>
          <Input
            id="current-password"
            type="password"
            autoComplete="current-password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="next-password">{t.admin.newPassword}</Label>
          <Input
            id="next-password"
            type="password"
            autoComplete="new-password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
          />
          <p className="text-xs text-slate-500">{t.admin.passwordRule}</p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="confirm-password">{t.admin.confirmPassword}</Label>
          <Input
            id="confirm-password"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
          {mismatch ? <p className="text-xs text-red-600">{t.admin.passwordMismatch}</p> : null}
        </div>
        <Button disabled={!ready || change.isPending} onClick={() => change.mutate({ current, next })}>
          {change.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
          {t.common.save}
        </Button>
      </CardContent>
    </Card>
  );
}
