import { trpc } from "@/providers/trpc";
import { useI18n } from "@/i18n";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ProfileImportDialog } from "@/components/ProfileImportDialog";
import { ProfilesTable } from "@/components/ProfilesTable";
import { OrganizationsCard } from "@/components/OrganizationsCard";
import { ApiKeysCard } from "@/components/ApiKeysCard";
import { MfaCard } from "@/components/MfaCard";
import { NotificationChannelsCard } from "@/components/NotificationChannelsCard";

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
        <p className="max-w-3xl text-sm text-slate-500">{t.settings.profilesHint}</p>
      </div>
      <Tabs defaultValue="profiles">
        <TabsList>
          <TabsTrigger value="profiles">{t.settings.tabProfiles}</TabsTrigger>
          <TabsTrigger value="general">{t.settings.tabGeneral}</TabsTrigger>
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
          <NotificationChannelsCard />
        </TabsContent>
        <TabsContent value="security" className="space-y-6 pt-4">
          {/* audit #23: per-user TOTP MFA */}
          <MfaCard />
          {/* v9.1: API keys (admin only) */}
          <ApiKeysCard />
        </TabsContent>
      </Tabs>
    </div>
  );
}
