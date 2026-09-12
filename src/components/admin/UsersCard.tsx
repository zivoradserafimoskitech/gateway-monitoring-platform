// §8: user management had a complete backend (auth.users / createUser /
// updateUser) and no screen at all — accounts could only be created by seeding
// the database. Admin-gated; an org admin sees only their own org's users
// because the query is already org-scoped server-side.
import { useState } from "react";
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtTime } from "@/components/shared";
import { Loader2, Plus, ShieldAlert, UserPlus } from "lucide-react";
import { toast } from "sonner";

type Role = "admin" | "operator" | "viewer";

export function UsersCard() {
  const { t } = useI18n();
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery();
  const isAdmin = !me.data?.authRequired || me.data?.user?.role === "admin";
  const users = trpc.auth.users.useQuery(undefined, { enabled: isAdmin });
  const orgs = trpc.orgs.list.useQuery(undefined, { enabled: me.data?.user?.isSuperadmin === true });

  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("viewer");
  const [orgId, setOrgId] = useState<string>("");

  const invalidate = () => void utils.auth.users.invalidate();
  const create = trpc.auth.createUser.useMutation({
    onSuccess: () => {
      invalidate();
      setOpen(false);
      setEmail("");
      setName("");
      setPassword("");
      setRole("viewer");
      toast.success(t.admin.userCreated);
    },
    onError: (e) => toast.error(e.message),
  });
  const update = trpc.auth.updateUser.useMutation({
    onSuccess: () => {
      invalidate();
      toast.success(t.admin.userUpdated);
    },
    onError: (e) => toast.error(e.message),
  });

  // A password reset is a separate, deliberate action — typing a new password
  // into the row would make it far too easy to reset the wrong account.
  const [resetFor, setResetFor] = useState<{ id: number; email: string } | null>(null);
  const [resetPassword, setResetPassword] = useState("");

  if (!isAdmin) return null;

  return (
    <Card>
      <CardHeader className="flex flex-row flex-wrap items-start justify-between gap-2">
        <div>
          <CardTitle>{t.admin.usersTitle}</CardTitle>
          <CardDescription>{t.admin.usersHint}</CardDescription>
        </div>
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogTrigger asChild>
            <Button size="sm" className="gap-1.5">
              <UserPlus className="h-4 w-4" /> {t.admin.newUser}
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{t.admin.newUser}</DialogTitle>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="new-user-email">{t.auth.email}</Label>
                <Input id="new-user-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new-user-name">{t.admin.fullName}</Label>
                <Input id="new-user-name" value={name} onChange={(e) => setName(e.target.value)} />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="new-user-password">{t.auth.password}</Label>
                <Input
                  id="new-user-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
                <p className="text-xs text-slate-500">{t.admin.passwordRule}</p>
              </div>
              <div className="space-y-1.5">
                <Label>{t.admin.role}</Label>
                <Select value={role} onValueChange={(v) => setRole(v as Role)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="viewer">{t.admin.roleViewer}</SelectItem>
                    <SelectItem value="operator">{t.admin.roleOperator}</SelectItem>
                    <SelectItem value="admin">{t.admin.roleAdmin}</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              {/* Only a superadmin may place a user in another org; everyone
                  else has their own org stamped by the server. */}
              {orgs.data && orgs.data.length > 0 && (
                <div className="space-y-1.5">
                  <Label>{t.orgs.title}</Label>
                  <Select value={orgId} onValueChange={setOrgId}>
                    <SelectTrigger>
                      <SelectValue placeholder={t.admin.orgDefault} />
                    </SelectTrigger>
                    <SelectContent>
                      {orgs.data.map((o) => (
                        <SelectItem key={o.id} value={String(o.id)}>
                          {o.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>
            <DialogFooter>
              <Button
                disabled={create.isPending || !email.trim() || !name.trim() || password.length < 8}
                onClick={() =>
                  create.mutate({
                    email: email.trim(),
                    name: name.trim(),
                    password,
                    role,
                    ...(orgId ? { orgId: Number(orgId) } : {}),
                  })
                }
              >
                {create.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : <Plus className="mr-1 h-4 w-4" />}
                {t.common.add}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t.auth.email}</TableHead>
              <TableHead>{t.admin.fullName}</TableHead>
              <TableHead>{t.admin.role}</TableHead>
              <TableHead>{t.mfa.title}</TableHead>
              <TableHead>{t.admin.created}</TableHead>
              <TableHead className="text-right">{t.common.actions}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {(users.data ?? []).map((u) => (
              <TableRow key={u.id}>
                <TableCell className="font-medium">
                  {u.email}
                  {u.isSuperadmin ? (
                    <span className="ml-1.5 inline-flex items-center gap-1 rounded-full bg-violet-100 px-2 py-0.5 text-xs text-violet-700">
                      <ShieldAlert className="h-3 w-3" /> {t.admin.superadmin}
                    </span>
                  ) : null}
                  {u.disabled ? (
                    <span className="ml-1.5 rounded-full bg-slate-200 px-2 py-0.5 text-xs text-slate-600">
                      {t.admin.disabled}
                    </span>
                  ) : null}
                </TableCell>
                <TableCell>{u.name}</TableCell>
                <TableCell>
                  <Select
                    value={u.role}
                    disabled={u.isSuperadmin || update.isPending}
                    onValueChange={(v) => update.mutate({ id: u.id, role: v as Role })}
                  >
                    <SelectTrigger className="h-8 w-32">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="viewer">{t.admin.roleViewer}</SelectItem>
                      <SelectItem value="operator">{t.admin.roleOperator}</SelectItem>
                      <SelectItem value="admin">{t.admin.roleAdmin}</SelectItem>
                    </SelectContent>
                  </Select>
                </TableCell>
                <TableCell className="text-sm text-slate-600">
                  {u.totpEnabled ? t.mfa.statusEnabled : t.mfa.statusDisabled}
                </TableCell>
                <TableCell className="text-sm text-slate-500">{fmtTime(u.createdAt)}</TableCell>
                <TableCell className="space-x-2 text-right whitespace-nowrap">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setResetFor({ id: u.id, email: u.email })}
                  >
                    {t.admin.resetPassword}
                  </Button>
                  <Button
                    variant={u.disabled ? "outline" : "ghost"}
                    size="sm"
                    disabled={u.isSuperadmin || update.isPending}
                    onClick={() => update.mutate({ id: u.id, disabled: !u.disabled })}
                  >
                    {u.disabled ? t.admin.enable : t.admin.disable}
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {(users.data ?? []).length === 0 && (
              <TableRow>
                <TableCell colSpan={6} className="text-sm text-slate-500">
                  {t.common.noData}
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </CardContent>

      <Dialog
        open={resetFor !== null}
        onOpenChange={(o) => {
          if (!o) {
            setResetFor(null);
            setResetPassword("");
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t.admin.resetPassword} — {resetFor?.email}
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="reset-password">{t.admin.newPassword}</Label>
            <Input
              id="reset-password"
              type="password"
              value={resetPassword}
              onChange={(e) => setResetPassword(e.target.value)}
            />
            <p className="text-xs text-slate-500">{t.admin.passwordRule}</p>
          </div>
          <DialogFooter>
            <Button
              disabled={resetPassword.length < 8 || update.isPending}
              onClick={() => {
                if (!resetFor) return;
                update.mutate(
                  { id: resetFor.id, password: resetPassword },
                  {
                    onSuccess: () => {
                      setResetFor(null);
                      setResetPassword("");
                    },
                  },
                );
              }}
            >
              {update.isPending ? <Loader2 className="mr-1 h-4 w-4 animate-spin" /> : null}
              {t.common.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}
