// v9.1/B2: API-key management card on Settings (admin only). The raw etk_ key
// is shown EXACTLY once after creation — afterwards only the prefix identifies
// it. Revocation is immediate (api_keys cache evicted server-side).
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Check, Copy, KeyRound, Loader2, Plus, Ban } from "lucide-react";
import { toast } from "sonner";

// audit wave 4: 4-scope model. No scopes ticked = read-only key (was full
// access). Labels live in the apiKeysScopes i18n section.
type Scope = "read" | "control" | "telemetry:read" | "ems:write";
const ALL_SCOPES: Scope[] = ["read", "control", "telemetry:read", "ems:write"];
const scopeLabelKey = (s: Scope) =>
  s === "telemetry:read" ? "telemetryRead" : s === "ems:write" ? "emsWrite" : s;

export function ApiKeysCard() {
  const { t } = useI18n();
  const me = trpc.auth.me.useQuery();
  const isAdmin = me.data?.user?.role === "admin";
  const utils = trpc.useUtils();
  const keys = trpc.apiKeys.list.useQuery(undefined, { enabled: isAdmin });
  const [name, setName] = useState("");
  const [role, setRole] = useState<"viewer" | "operator" | "admin">("viewer");
  // audit P1-7/wave-4: optional expiry + scope restriction (no scopes ticked = read-only).
  const [expiry, setExpiry] = useState("");
  const [scopes, setScopes] = useState<Scope[]>([]);
  const [freshKey, setFreshKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const toggleScope = (s: Scope) =>
    setScopes((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  const create = trpc.apiKeys.create.useMutation({
    onSuccess: (res) => {
      void utils.apiKeys.list.invalidate();
      setName("");
      setExpiry("");
      setScopes([]);
      setFreshKey(res.key); // the ONLY time the raw key exists anywhere
      toast.success(t.apiKeys.created);
    },
    onError: (e) => toast.error(e.message),
  });
  const revoke = trpc.apiKeys.revoke.useMutation({
    onSuccess: () => {
      void utils.apiKeys.list.invalidate();
      toast.success(t.apiKeys.revoked);
    },
    onError: (e) => toast.error(e.message),
  });
  if (!isAdmin) return null;

  const copy = async () => {
    if (!freshKey) return;
    try {
      await navigator.clipboard.writeText(freshKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(t.apiKeys.copyFailed);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="h-4 w-4" /> {t.apiKeys.title}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Input className="max-w-56" placeholder={t.apiKeys.namePlaceholder} value={name} onChange={(e) => setName(e.target.value)} />
          <Select value={role} onValueChange={(v) => setRole(v as typeof role)}>
            <SelectTrigger className="h-9 w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="viewer">viewer</SelectItem>
              <SelectItem value="operator">operator</SelectItem>
              <SelectItem value="admin">admin</SelectItem>
            </SelectContent>
          </Select>
          <Input
            className="max-w-44"
            type="date"
            title={t.apiKeys.expires}
            value={expiry}
            onChange={(e) => setExpiry(e.target.value)}
          />
          {ALL_SCOPES.map((s) => (
            <label key={s} className="flex items-center gap-1.5 text-sm">
              <Checkbox checked={scopes.includes(s)} onCheckedChange={() => toggleScope(s)} />
              {t.apiKeysScopes[scopeLabelKey(s)]}
            </label>
          ))}
          <span className="self-center text-xs text-slate-400">{t.apiKeysScopes.hint}</span>
          <Button
            size="sm"
            disabled={create.isPending || !name.trim()}
            onClick={() =>
              create.mutate({
                name: name.trim(),
                role,
                expiresAt: expiry ? new Date(`${expiry}T23:59:59Z`).toISOString() : undefined,
                scopes: scopes.length ? scopes : undefined,
              })
            }
          >
            {create.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <Plus className="h-3 w-3" />}
            {t.common.add}
          </Button>
        </div>

        {freshKey && (
          <div className="rounded-md border border-amber-300 bg-amber-50 p-3">
            <p className="mb-1 text-xs font-medium text-amber-800">{t.apiKeys.showOnce}</p>
            <div className="flex items-center gap-2">
              <code className="flex-1 break-all rounded bg-white px-2 py-1 font-mono text-xs">{freshKey}</code>
              <Button size="sm" variant="outline" onClick={() => void copy()}>
                {copied ? <Check className="h-3 w-3 text-emerald-600" /> : <Copy className="h-3 w-3" />}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setFreshKey(null)}>
                {t.apiKeys.done}
              </Button>
            </div>
          </div>
        )}

        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.orgs.name}</TableHead>
              <TableHead>{t.apiKeys.prefix}</TableHead>
              <TableHead>{t.apiKeys.role}</TableHead>
              <TableHead>{t.apiKeys.lastUsed}</TableHead>
              <TableHead>{t.apiKeys.expires}</TableHead>
              <TableHead>{t.apiKeys.scopes}</TableHead>
              <TableHead>{t.apiKeys.status}</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {(keys.data ?? []).map((k) => (
              <TableRow key={k.id} className={k.revokedAt ? "opacity-50" : ""}>
                <TableCell>{k.name}</TableCell>
                <TableCell className="font-mono text-xs">{k.prefix}…</TableCell>
                <TableCell>{k.role}</TableCell>
                <TableCell className="text-xs text-slate-500">
                  {k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : "—"}
                </TableCell>
                <TableCell className="text-xs">
                  {k.expiresAt ? (
                    <span className="flex items-center gap-1">
                      {new Date(k.expiresAt).toLocaleDateString()}
                      {new Date(k.expiresAt).getTime() <= Date.now() && (
                        <Badge variant="destructive">{t.apiKeys.expiredStatus}</Badge>
                      )}
                    </span>
                  ) : (
                    <span className="text-slate-400">{t.apiKeys.noExpiry}</span>
                  )}
                </TableCell>
                <TableCell className="text-xs">
                  {k.scopes && k.scopes.length ? (
                    <span className="flex gap-1">
                      {k.scopes.map((s) => (
                        <Badge key={s} variant="secondary">
                          {s}
                        </Badge>
                      ))}
                    </span>
                  ) : (
                    <span className="text-slate-400">{t.apiKeysScopes.legacyReadOnly}</span>
                  )}
                </TableCell>
                <TableCell>{k.revokedAt ? t.apiKeys.revokedStatus : t.apiKeys.activeStatus}</TableCell>
                <TableCell className="text-right">
                  {!k.revokedAt && (
                    <Button size="sm" variant="ghost" disabled={revoke.isPending} onClick={() => revoke.mutate({ id: k.id })}>
                      <Ban className="h-3 w-3 text-red-500" />
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}
