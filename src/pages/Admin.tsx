// §8: administration screens for backend capability that had none — users,
// the audit trail, the unclaimed-device queue and Modbus poller health.
// Everything here is admin-gated server-side as well; this page only decides
// what to render, never what is allowed.
import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { UsersCard } from "@/components/admin/UsersCard";
import { AuditLogCard } from "@/components/admin/AuditLogCard";
import { UnclaimedDevicesCard } from "@/components/admin/UnclaimedDevicesCard";
import { DeviceRegistrationsCard } from "@/components/admin/DeviceRegistrationsCard";
import { PollerStatusCard } from "@/components/admin/PollerStatusCard";
import { OrganizationsCard } from "@/components/OrganizationsCard";

export default function Admin() {
  const { t } = useI18n();
  const me = trpc.auth.me.useQuery();
  const isAdmin = !me.data?.authRequired || me.data?.user?.role === "admin";
  const isSuper = me.data?.user?.isSuperadmin === true;
  // The unclaimed queue counts across tenants, so it is superadmin-only; the
  // badge tells them there is work here without opening the tab.
  const unclaimed = trpc.orgs.unclaimedDevices.useQuery(undefined, {
    enabled: isSuper,
    refetchInterval: 60_000,
  });

  if (!isAdmin) {
    return (
      <div className="space-y-2">
        <h1 className="text-2xl font-bold tracking-tight">{t.admin.title}</h1>
        <p className="text-sm text-muted-foreground">{t.admin.forbidden}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t.admin.title}</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">{t.admin.hint}</p>
      </div>
      <Tabs defaultValue="users">
        <TabsList className="flex-wrap">
          <TabsTrigger value="users">{t.admin.usersTitle}</TabsTrigger>
          <TabsTrigger value="audit">{t.admin.auditTitle}</TabsTrigger>
          {isSuper && (
            <TabsTrigger value="unclaimed" className="gap-1.5">
              {t.admin.unclaimedTitle}
              {unclaimed.data && unclaimed.data.total > 0 ? (
                <span className="rounded-full bg-amber-100 px-1.5 text-xs text-amber-700">
                  {unclaimed.data.total}
                </span>
              ) : null}
            </TabsTrigger>
          )}
          <TabsTrigger value="devices">{t.admin.regTitle}</TabsTrigger>
          <TabsTrigger value="poller">{t.admin.pollerTitle}</TabsTrigger>
        </TabsList>
        <TabsContent value="users" className="space-y-6 pt-4">
          <UsersCard />
          {isSuper && <OrganizationsCard />}
        </TabsContent>
        <TabsContent value="audit" className="pt-4">
          <AuditLogCard />
        </TabsContent>
        {isSuper && (
          <TabsContent value="unclaimed" className="pt-4">
            <UnclaimedDevicesCard />
          </TabsContent>
        )}
        <TabsContent value="devices" className="pt-4">
          <DeviceRegistrationsCard />
        </TabsContent>
        <TabsContent value="poller" className="pt-4">
          <PollerStatusCard />
        </TabsContent>
      </Tabs>
    </div>
  );
}
