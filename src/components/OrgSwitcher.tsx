// §9.11: the org switcher.
//
// Shown only when there is something to switch between — a single-tenant
// deployment, and every user who belongs to exactly one organization, sees the
// header exactly as it was. A control that does nothing is worse than no
// control: it invites the click and then explains that nothing happened.
//
// Switching reloads the page deliberately. Every query in the app is scoped to
// the active org, so a switch invalidates all of them at once; a full reload is
// honest about that, and it avoids a window where half the screen shows one
// tenant and half shows the other.
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Building2, Check, Loader2 } from "lucide-react";
import { toast } from "sonner";

export function OrgSwitcher() {
  const { t } = useI18n();
  const me = trpc.auth.me.useQuery();
  const mine = trpc.orgs.myOrgs.useQuery(undefined, { enabled: Boolean(me.data?.user) });
  const switchOrg = trpc.orgs.switchOrg.useMutation({
    onSuccess: () => window.location.reload(),
    onError: (e) => toast.error(e.message),
  });

  const orgs = mine.data?.orgs ?? [];
  if (orgs.length < 2) return null;
  const active = orgs.find((o) => o.orgId === mine.data?.activeOrgId);

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2" disabled={switchOrg.isPending}>
          {switchOrg.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Building2 className="h-4 w-4" />}
          <span className="hidden max-w-40 truncate sm:inline">{active?.name ?? t.orgSwitch.pick}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {orgs.map((o) => (
          <DropdownMenuItem
            key={o.orgId}
            onClick={() => {
              if (o.orgId !== mine.data?.activeOrgId) switchOrg.mutate({ orgId: o.orgId });
            }}
          >
            <span className="flex-1">{o.name}</span>
            <span className="ml-3 text-xs text-muted-foreground">
              {/* A superadmin sees every org, including ones they hold no
                  membership in; saying so keeps "why am I an admin here"
                  answerable. */}
              {o.viaSuperadmin ? t.orgSwitch.viaSuperadmin : o.role}
            </span>
            {o.orgId === mine.data?.activeOrgId && <Check className="ml-2 h-4 w-4" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
