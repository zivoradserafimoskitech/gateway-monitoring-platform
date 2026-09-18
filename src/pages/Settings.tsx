import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProfileImportDialog } from "@/components/ProfileImportDialog";
import { ProfilesTable } from "@/components/ProfilesTable";
import { OrganizationsCard } from "@/components/OrganizationsCard";
import { ApiKeysCard } from "@/components/ApiKeysCard";
import { MfaCard } from "@/components/MfaCard";
import { NotificationChannelsCard } from "@/components/NotificationChannelsCard";
import { MaintenanceWindowsCard } from "@/components/MaintenanceWindowsCard";
import { OnCallRotaCard } from "@/components/OnCallRotaCard";
import { AlarmSuppressionCard } from "@/components/AlarmSuppressionCard";
import { DeliveryHistoryCard } from "@/components/DeliveryHistoryCard";
import { WebhooksCard } from "@/components/WebhooksCard";
import { WebhookDeliveriesCard } from "@/components/WebhookDeliveriesCard";
import { ChangePasswordCard } from "@/components/ChangePasswordCard";

// Wave 8: Settings is split into tabs — Device profiles (default, the
// operational content) gets a compact searchable/filterable table; General and
// Security hold the relocated cards (unchanged components).
export default function Settings() {
  const { t } = useI18n();
  const profiles = trpc.profiles.list.useQuery();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t.settings.title}</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">{t.settings.profilesHint}</p>
      </div>
      <Tabs defaultValue="profiles">
        <TabsList className="flex-wrap">
          <TabsTrigger value="profiles">{t.settings.tabProfiles}</TabsTrigger>
          <TabsTrigger value="general">{t.settings.tabGeneral}</TabsTrigger>
          <TabsTrigger value="notifications">{t.settings.tabNotifications}</TabsTrigger>
          <TabsTrigger value="security">{t.settings.tabSecurity}</TabsTrigger>
        </TabsList>
        <TabsContent value="profiles" className="space-y-4 pt-4">
          <div className="flex justify-end">
            {/* Wave 5 / T2: adding a vendor profile is data entry, not a code change */}
            <ProfileImportDialog />
          </div>
          <ProfilesTable profiles={profiles.data ?? []} />
        </TabsContent>
        <TabsContent value="general" className="space-y-6 pt-4">
          {/* v8/D2: organizations — superadmin only */}
          <OrganizationsCard />
        </TabsContent>
        <TabsContent value="notifications" className="space-y-6 pt-4">
          <NotificationChannelsCard />
          {/* §8: suppression windows and the delivery trail belong next to the
              channels they act on — all three answer "who gets told, when, and
              did it actually arrive". */}
          <MaintenanceWindowsCard />
          {/* §9.8: the narrow cousin of a maintenance window — one rule or one
              device silenced with a reason, while the alarm still gets raised
              and recorded. */}
          <AlarmSuppressionCard />
          {/* §9.8: and who is actually awake to receive what is left. */}
          <OnCallRotaCard />
          <DeliveryHistoryCard />
          {/* §9.15: the same tab, because "who gets told" is the question —
              but a webhook subscription tells a SYSTEM, which needs a
              signature, a queue and control events as well as alarms. */}
          <WebhooksCard />
          <WebhookDeliveriesCard />
        </TabsContent>
        <TabsContent value="security" className="space-y-6 pt-4">
          {/* §8: the backend could change a password; nothing called it. */}
          <ChangePasswordCard />
          {/* audit #23: per-user TOTP MFA */}
          <MfaCard />
          {/* v9.1: API keys (admin only) */}
          <ApiKeysCard />
        </TabsContent>
      </Tabs>
    </div>
  );
}
