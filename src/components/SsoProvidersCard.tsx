// §9.12: OIDC provider configuration (admin only).
//
// A procurement blocker rather than a feature: industrial customers hand over
// their SSO requirements before they will discuss anything else.
//
// Two things on this screen are deliberate. A provider is created DISABLED,
// because a half-configured button on the login screen is a button that fails
// in front of a customer. And the caveat is printed, not hidden in a commit
// message: this is the one feature in the system that cannot be verified end
// to end in CI, and whoever enables it should know that before they do.
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
import { ConfirmButton } from "@/components/ConfirmButton";
import { KeyRound, Loader2, Plus } from "lucide-react";
import { toast } from "sonner";

type Role = "admin" | "operator" | "viewer";

export function SsoProvidersCard() {
  const { t } = useI18n();
  const me = trpc.auth.me.useQuery();
  const isAdmin = me.data?.user?.role === "admin";
  const utils = trpc.useUtils();
  const providers = trpc.auth.ssoProviderList.useQuery(undefined, { enabled: isAdmin });

  const [name, setName] = useState("");
  const [issuer, setIssuer] = useState("");
  const [clientId, setClientId] = useState("");
  const [clientSecret, setClientSecret] = useState("");
  const [authEp, setAuthEp] = useState("");
  const [tokenEp, setTokenEp] = useState("");
  const [jwks, setJwks] = useState("");
  const [domains, setDomains] = useState("");
  const [autoProvision, setAutoProvision] = useState(false);
  const [role, setRole] = useState<Role>("viewer");

  const invalidate = () => {
    void utils.auth.ssoProviderList.invalidate();
    void utils.auth.ssoProviders.invalidate();
  };
  const save = trpc.auth.ssoProviderSave.useMutation({
    onSuccess: () => {
      invalidate();
      setName("");
      setClientSecret("");
      toast.success(t.sso.saved);
    },
    onError: (e) => toast.error(e.message),
  });
  const remove = trpc.auth.ssoProviderRemove.useMutation({
    onSuccess: () => {
      invalidate();
      toast.success(t.sso.removed);
    },
    onError: (e) => toast.error(e.message),
  });

  if (!isAdmin) return null;
  const rows = providers.data ?? [];
  const redirectUri = typeof window !== "undefined" ? `${window.location.origin}/api/auth/oidc/callback` : "";
  const complete = [name, issuer, clientId, authEp, tokenEp, jwks].every((v) => v.trim().length > 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-4 w-4" /> {t.sso.title}
        </CardTitle>
        <CardDescription>{t.sso.hint}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          {t.sso.caveat}
        </p>
        <p className="text-xs text-muted-foreground">
          {t.sso.redirectUri}: <code className="rounded bg-muted px-1.5 py-0.5 font-mono">{redirectUri}</code>
        </p>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div className="space-y-1.5">
            <Label htmlFor="sso-name">{t.sso.name}</Label>
            <Input id="sso-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sso-issuer">{t.sso.issuer}</Label>
            <Input id="sso-issuer" value={issuer} onChange={(e) => setIssuer(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sso-client">{t.sso.clientId}</Label>
            <Input id="sso-client" value={clientId} onChange={(e) => setClientId(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sso-secret">{t.sso.clientSecret}</Label>
            <Input
              id="sso-secret"
              type="password"
              placeholder={t.sso.clientSecretKeep}
              value={clientSecret}
              onChange={(e) => setClientSecret(e.target.value)}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sso-auth">{t.sso.authEndpoint}</Label>
            <Input id="sso-auth" value={authEp} onChange={(e) => setAuthEp(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sso-token">{t.sso.tokenEndpoint}</Label>
            <Input id="sso-token" value={tokenEp} onChange={(e) => setTokenEp(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sso-jwks">{t.sso.jwksUri}</Label>
            <Input id="sso-jwks" value={jwks} onChange={(e) => setJwks(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="sso-domains" title={t.sso.allowedDomainsHint}>
              {t.sso.allowedDomains}
            </Label>
            <Input id="sso-domains" value={domains} onChange={(e) => setDomains(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label title={t.sso.defaultRoleHint}>{t.sso.defaultRole}</Label>
            <Select value={role} onValueChange={(v) => setRole(v as Role)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="viewer">viewer</SelectItem>
                <SelectItem value="operator">operator</SelectItem>
                <SelectItem value="admin">admin</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <Checkbox checked={autoProvision} onCheckedChange={() => setAutoProvision((v) => !v)} />
            {t.sso.autoProvision}
          </label>
          <div className="flex items-end lg:col-span-2">
            <Button
              className="w-full"
              disabled={!complete || save.isPending}
              onClick={() =>
                save.mutate({
                  name: name.trim(),
                  issuer: issuer.trim(),
                  clientId: clientId.trim(),
                  ...(clientSecret ? { clientSecret } : {}),
                  authorizationEndpoint: authEp.trim(),
                  tokenEndpoint: tokenEp.trim(),
                  jwksUri: jwks.trim(),
                  allowedDomains: domains
                    .split(",")
                    .map((d) => d.trim())
                    .filter(Boolean),
                  autoProvision,
                  defaultRole: role,
                  // Always created disabled; enabling is a separate click on
                  // the row below, once the values have been checked.
                  enabled: false,
                })
              }
            >
              {save.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Plus className="mr-1 h-4 w-4" />}
              {t.sso.save}
            </Button>
          </div>
        </div>

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.sso.name}</TableHead>
              <TableHead>{t.sso.issuer}</TableHead>
              <TableHead>{t.sso.allowedDomains}</TableHead>
              <TableHead>{t.sso.defaultRole}</TableHead>
              <TableHead>{t.common.status}</TableHead>
              <TableHead className="text-right">{t.common.actions}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((p) => {
              const doms = Array.isArray(p.allowedDomains) ? (p.allowedDomains as string[]) : [];
              return (
                <TableRow key={p.id}>
                  <TableCell className="font-medium">{p.name}</TableCell>
                  <TableCell className="max-w-64 truncate font-mono text-xs" title={p.issuer}>
                    {p.issuer}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">
                    {doms.length ? doms.join(" ") : "—"}
                    {p.autoProvision ? ` · ${t.sso.autoProvision}` : ""}
                  </TableCell>
                  <TableCell className="text-sm">{p.defaultRole}</TableCell>
                  <TableCell>
                    <span
                      className={
                        p.enabled
                          ? "rounded-full bg-emerald-100 px-2 py-0.5 text-xs text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
                          : "rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground"
                      }
                    >
                      {p.enabled ? t.sso.enabled : t.notif.disabled}
                    </span>
                  </TableCell>
                  <TableCell className="space-x-1 text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={save.isPending}
                      onClick={() =>
                        save.mutate({
                          id: p.id,
                          name: p.name,
                          issuer: p.issuer,
                          clientId: p.clientId,
                          authorizationEndpoint: p.authorizationEndpoint,
                          tokenEndpoint: p.tokenEndpoint,
                          jwksUri: p.jwksUri,
                          scopes: p.scopes,
                          allowedDomains: doms,
                          autoProvision: p.autoProvision,
                          defaultRole: p.defaultRole,
                          enabled: !p.enabled,
                        })
                      }
                    >
                      {p.enabled ? t.notif.disabled : t.sso.enabled}
                    </Button>
                    <ConfirmButton
                      title={t.sso.removeTitle}
                      description={t.sso.removeHint}
                      onConfirm={() => remove.mutate({ id: p.id })}
                    />
                  </TableCell>
                </TableRow>
              );
            })}
            {rows.length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-sm text-muted-foreground">
                  {t.sso.empty}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
