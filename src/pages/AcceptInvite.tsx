// §9.11: accepting an invitation.
//
// Reachable without a session, which is the point — the person following the
// link does not have an account yet. It sits OUTSIDE the login gate in App.tsx
// for that reason: sending somebody an invitation and then showing them a
// login screen is the loop this feature exists to break.
//
// Accepting does not sign anyone in. A link sitting in an inbox should not be
// enough to be holding a session, so the last step is an ordinary login.
import { useState } from "react";
import { useNavigate, useParams } from "react-router";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";

export default function AcceptInvite() {
  const { t } = useI18n();
  const { token } = useParams<{ token: string }>();
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [done, setDone] = useState(false);

  const accept = trpc.orgs.acceptInvite.useMutation({
    onSuccess: () => {
      setDone(true);
      toast.success(t.orgMembers.accepted);
      // Straight to the login screen: the account exists now, and the next
      // thing they need is to sign in with it.
      setTimeout(() => void navigate("/"), 1200);
    },
    onError: (e) => toast.error(e.message || t.orgMembers.acceptFailed),
  });

  const canSubmit = Boolean(token) && name.trim().length > 0 && password.length >= 8;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>{t.orgMembers.acceptTitle}</CardTitle>
          <CardDescription>{t.orgMembers.acceptHint}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs text-muted-foreground">{t.orgMembers.acceptExisting}</p>
          <div className="space-y-1.5">
            <Label htmlFor="invite-name">{t.common.name}</Label>
            <Input id="invite-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="invite-password">{t.auth.password}</Label>
            <Input
              id="invite-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
            />
          </div>
          <Button
            className="w-full"
            disabled={!canSubmit || accept.isPending || done}
            onClick={() => accept.mutate({ token: token!, name: name.trim(), password })}
          >
            {accept.isPending && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}
            {t.orgMembers.accept}
          </Button>
        </CardContent>
      </Card>
    </div>
  );
}
