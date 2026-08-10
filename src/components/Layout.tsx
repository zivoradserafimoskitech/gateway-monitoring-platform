import { Link, NavLink, Outlet } from "react-router";
import {
  LayoutDashboard,
  Radio,
  Gauge,
  BellRing,
  FileBarChart,
  Settings,
  Zap,
  Languages,
  UserCircle,
  LogOut,
} from "lucide-react";
import { useI18n } from "@/i18n";
import { trpc, setSessionToken } from "@/providers/trpc";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function Layout() {
  const { t, lang, setLang } = useI18n();
  const utils = trpc.useUtils();
  const me = trpc.auth.me.useQuery(undefined, { retry: false, staleTime: 60_000 });
  const logout = trpc.auth.logout.useMutation({
    onSuccess: () => {
      setSessionToken(null);
      utils.invalidate();
    },
  });
  const mqttStatus = trpc.gateways.mqttStatus.useQuery(undefined, { refetchInterval: 10000 });

  const nav = [
    { to: "/", icon: LayoutDashboard, label: t.nav.dashboard, end: true },
    { to: "/gateways", icon: Radio, label: t.nav.gateways },
    { to: "/meters", icon: Gauge, label: t.nav.meters },
    { to: "/alarms", icon: BellRing, label: t.nav.alarms },
    { to: "/reports", icon: FileBarChart, label: t.nav.reports },
    { to: "/settings", icon: Settings, label: t.nav.settings },
  ];

  const mqtt = mqttStatus.data;

  return (
    <div className="flex min-h-screen bg-slate-50">
      {/* Sidebar */}
      <aside className="fixed inset-y-0 left-0 z-20 flex w-60 flex-col border-r bg-slate-900 text-slate-100">
        <Link to="/" className="flex items-center gap-2 px-5 py-5">
          <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500">
            <Zap className="h-5 w-5 text-white" />
          </span>
          <span className="text-lg font-semibold tracking-tight">{t.appName}</span>
        </Link>
        <nav className="mt-2 flex-1 space-y-1 px-3">
          {nav.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.end}
              className={({ isActive }) =>
                cn(
                  "flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors",
                  isActive
                    ? "bg-emerald-500/15 text-emerald-400"
                    : "text-slate-300 hover:bg-slate-800 hover:text-white",
                )
              }
            >
              <item.icon className="h-4 w-4" />
              {item.label}
            </NavLink>
          ))}
        </nav>
        <div className="border-t border-slate-800 px-5 py-4 text-xs text-slate-400">
          <div className="flex items-center gap-2">
            <span
              className={cn(
                "h-2 w-2 rounded-full",
                mqtt?.running && mqtt.connected ? "bg-emerald-400" : "bg-red-400",
              )}
            />
            {t.dashboard.mqttConnected}
          </div>
          {mqtt?.running && (
            <div className="mt-1 text-slate-500">
              {mqtt.externalBroker ? t.dashboard.mqttExternal : t.dashboard.mqttEmbedded}
              {mqtt.embeddedBrokerPort ? ` :${mqtt.embeddedBrokerPort}` : ""} · {mqtt.messagesIn}{" "}
              {t.dashboard.messagesIn}
            </div>
          )}
        </div>
      </aside>

      {/* Main */}
      <div className="ml-60 flex min-h-screen flex-1 flex-col">
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between border-b bg-white/80 px-6 backdrop-blur">
          <div />
          <div className="flex items-center gap-3">
            {me.data?.user && (
              <span className="flex items-center gap-2 text-sm text-slate-600">
                <UserCircle className="h-4 w-4" />
                {me.data.user.name}
                <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
                  {me.data.user.role}
                </span>
              </span>
            )}
            {me.data?.user && (
              <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => logout.mutate()}>
                <LogOut className="h-4 w-4" />
                {t.auth.signOut}
              </Button>
            )}
            <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2">
                <Languages className="h-4 w-4" />
                {lang === "en" ? t.lang.en : t.lang.mk}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => setLang("en")}>{t.lang.en}</DropdownMenuItem>
              <DropdownMenuItem onClick={() => setLang("mk")}>{t.lang.mk}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          </div>
        </header>
        <main className="flex-1 p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
