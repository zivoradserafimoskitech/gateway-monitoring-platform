// §9.11: membership and invitations.
//
// Before this, adding somebody meant an admin typing a password on their
// behalf and sending it over chat, and a person could belong to exactly one
// organization — so an engineer looking after three customers' sites needed
// three accounts.
//
// The invite link is shown once, like an API key, and is also emailed when a
// mailer is configured. Shown as well as emailed on purpose: a deployment with
// no SMTP must still be able to invite somebody, through whatever channel it
// actually has.
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { useNow } from "@/hooks/use-now";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ConfirmButton } from "@/components/ConfirmButton";
import { fmtTime } from "@/components/shared";
import { Check, Copy, Loader2, Send } from "lucide-react";
import { toast } from "sonner";

type Role = "admin" | "operator" | "viewer";

export function OrgMembersCard() {
  const { t } = useI18n();
  const me = trpc.auth.me.useQuery();
  const isAdmin = me.data?.user?.role === "admin";
  const utils = trpc.useUtils();
  const now = useNow();
  const members = trpc.orgs.members.useQuery(undefined, { enabled: isAdmin });
  const invites = trpc.orgs.invites.useQuery(undefined, { enabled: isAdmin });

  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [freshLink, setFreshLink] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const invalidate = () => {
    void utils.orgs.members.invalidate();
    void utils.orgs.invites.invalidate();
  };
  const invite = trpc.orgs.invite.useMutation({
    onSuccess: (res) => {
      invalidate();
      setEmail("");
      setFreshLink(`${window.location.origin}${res.link}`);
      toast.success(t.orgMembers.invited);
    },
    onError: (e) => toast.error(e.message),
  });
  const revoke = trpc.orgs.revokeInvite.useMutation({ onSuccess: invalidate, onError: (e) => toast.error(e.message) });
  const setRoleM = trpc.orgs.setMemberRole.useMutation({
    onSuccess: () => {
      invalidate();
      toast.success(t.orgMembers.roleSaved);
    },
    onError: (e) => toast.error(e.message),
  });
  const removeM = trpc.orgs.removeMember.useMutation({ onSuccess: invalidate, onError: (e) => toast.error(e.message) });

  if (!isAdmin) return null;

  const copy = async () => {
    if (!freshLink) return;
    try {
      await navigator.clipboard.writeText(freshLink);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t.orgMembers.copyFailed);
    }
  };

  // Reading the clock during render is impure, and it is also wrong here: an
  // invite that expires in two minutes should start reading "expired" two
  // minutes later without somebody reloading the page.
  const inviteState = (i: { revokedAt: Date | null; acceptedAt: Date | null; expiresAt: Date }): string => {
    if (i.revokedAt) return t.orgMembers.inviteRevoked;
    if (i.acceptedAt) return t.orgMembers.inviteAccepted;
    if (new Date(i.expiresAt).getTime() <= now) return t.orgMembers.inviteExpired;
    return t.orgMembers.invitePending;
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t.orgMembers.title}</CardTitle>
        <CardDescription>{t.orgMembers.hint}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            className="max-w-72"
            type="email"
            placeholder={t.orgMembers.emailPlaceholder}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Select value={role} onValueChange={(v) => setRole(v as Role)}>
            <SelectTrigger className="h-9 w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="viewer">viewer</SelectItem>
              <SelectItem value="operator">operator</SelectItem>
              <SelectItem value="admin">admin</SelectItem>
            </SelectContent>
          </Select>
          <Button
            size="sm"
            disabled={invite.isPending || !email.trim()}
            onClick={() => invite.mutate({ email: email.trim(), role })}
          >
            {invite.isPending ? <Loader2 className="mr-1 h-3 w-3 animate-spin" /> : <Send className="mr-1 h-3 w-3" />}
            {t.orgMembers.invite}
          </Button>
        </div>

        {freshLink && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3 dark:border-amber-900 dark:bg-amber-950">
            <p className="mb-1 text-xs font-medium text-amber-800 dark:text-amber-200">{t.orgMembers.linkOnce}</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all rounded bg-card px-2 py-1 font-mono text-xs">{freshLink}</code>
              <Button size="sm" variant="outline" onClick={() => void copy()}>
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              </Button>
            </div>
          </div>
        )}

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.common.name}</TableHead>
              <TableHead>{t.auth.email}</TableHead>
              <TableHead>{t.orgs.title}</TableHead>
              <TableHead>{t.orgMembers.role}</TableHead>
              <TableHead className="text-right">{t.common.actions}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(members.data ?? []).map((m) => (
              <TableRow key={`${m.userId}-${m.orgId}`}>
                <TableCell className="font-medium">{m.name}</TableCell>
                <TableCell className="text-sm text-muted-foreground">{m.email}</TableCell>
                <TableCell className="text-sm">{m.orgName}</TableCell>
                <TableCell>
                  <Select
                    value={m.role}
                    onValueChange={(v) => setRoleM.mutate({ userId: m.userId, orgId: m.orgId, role: v as Role })}
                  >
                    <SelectTrigger className="h-8 w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="viewer">viewer</SelectItem>
                      <SelectItem value="operator">operator</SelectItem>
                      <SelectItem value="admin">admin</SelectItem>
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell className="text-right">
                  {m.userId !== me.data?.user?.id && (
                    <ConfirmButton
                      title={t.orgMembers.removeTitle}
                      description={t.orgMembers.removeHint}
                      onConfirm={() => removeM.mutate({ userId: m.userId, orgId: m.orgId })}
                    />
                  )}
                </TableCell>
              </TableRow>
            ))}
            {(members.data ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={5} className="text-sm text-muted-foreground">
                  {t.common.noData}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>

        <div>
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t.orgMembers.invitesTitle}
          </h3>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t.auth.email}</TableHead>
                <TableHead>{t.orgMembers.role}</TableHead>
                <TableHead>{t.common.status}</TableHead>
                <TableHead>{t.orgMembers.expires}</TableHead>
                <TableHead className="text-right">{t.common.actions}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(invites.data ?? []).map((i) => (
                <TableRow key={i.id}>
                  <TableCell className="text-sm">{i.email}</TableCell>
                  <TableCell className="text-sm">{i.role}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">{inviteState(i)}</TableCell>
                  <TableCell className="whitespace-nowrap text-xs">{fmtTime(i.expiresAt)}</TableCell>
                  <TableCell className="text-right">
                    {!i.acceptedAt && !i.revokedAt && (
                      <Button size="sm" variant="outline" disabled={revoke.isPending} onClick={() => revoke.mutate({ id: i.id })}>
                        {t.orgMembers.revoke}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
              {(invites.data ?? []).length === 0 && (
                <TableRow>
                  <TableCell colSpan={5} className="text-sm text-muted-foreground">
                    {t.orgMembers.noInvites}
                  </TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
