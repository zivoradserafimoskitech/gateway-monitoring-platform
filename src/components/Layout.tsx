import { useState } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router";
import {
  LayoutDashboard,
  Radio,
  Gauge,
  BellRing,
  BatteryCharging,
  CloudUpload,
  FileBarChart,
  Settings,
  ShieldCheck,
  Zap,
  Languages,
  Menu,
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
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { ThemeToggle } from "@/components/ThemeToggle";
import { GlobalSearch } from "@/components/GlobalSearch";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface NavItem {
  to: string;
  icon: typeof LayoutDashboard;
  label: string;
  end?: boolean;
}

// The nav renders twice — in the fixed desktop rail and inside the mobile
// drawer — so it lives in one component rather than being duplicated.
function SidebarNav({ items, onNavigate }: { items: NavItem[]; onNavigate?: () => void }) {
  return (
    <nav className="mt-2 flex-1 space-y-1 px-3">
      {items.map((item) => (
        <NavLink
          key={item.to}
          to={item.to}
          end={item.end}
          onClick={onNavigate}
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
  );
}

function MqttFooter() {
  const { t } = useI18n();
  const mqttStatus = trpc.gateways.mqttStatus.useQuery(undefined, { refetchInterval: 10000 });
  const mqtt = mqttStatus.data;
  return (
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
  );
}

function Brand({ onNavigate }: { onNavigate?: () => void }) {
  const { t } = useI18n();
  return (
    <Link to="/" onClick={onNavigate} className="flex items-center gap-2 px-5 py-5">
      <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-emerald-500">
        <Zap className="h-5 w-5 text-white" />
      </span>
      <span className="text-lg font-semibold tracking-tight">{t.appName}</span>
    </Link>
  );
}

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
  // Drawer state is local and closes on navigation — a menu left open over the
  // page the user just picked is the classic mobile-nav bug.
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();

  const nav: NavItem[] = [
    { to: "/", icon: LayoutDashboard, label: t.nav.dashboard, end: true },
    { to: "/gateways", icon: Radio, label: t.nav.gateways },
    { to: "/meters", icon: Gauge, label: t.nav.meters },
    { to: "/alarms", icon: BellRing, label: t.nav.alarms },
    { to: "/ems", icon: BatteryCharging, label: t.nav.ems },
    { to: "/ota", icon: CloudUpload, label: t.nav.ota },
    { to: "/reports", icon: FileBarChart, label: t.nav.reports },
    { to: "/settings", icon: Settings, label: t.nav.settings },
  ];
  // Administration is admin-only. In demo mode (no auth) there is no user
  // object at all, and the server enforces the role regardless — showing the
  // entry there keeps the demo complete without weakening anything.
  const role = me.data?.user?.role;
  if (!me.data?.authRequired || role === "admin") {
    nav.push({ to: "/admin", icon: ShieldCheck, label: t.nav.admin });
  }

  return (
    <div className="flex min-h-screen bg-muted/40">
      {/* Desktop rail: fixed, and hidden below lg where the drawer takes over. */}
      <aside className="fixed inset-y-0 left-0 z-20 hidden w-60 flex-col border-r bg-slate-900 text-slate-100 lg:flex">
        <Brand />
        <SidebarNav items={nav} />
        <MqttFooter />
      </aside>

      <div className="flex min-h-screen flex-1 flex-col lg:ml-60">
        <header className="sticky top-0 z-10 flex h-14 items-center justify-between gap-2 border-b bg-background/80 px-4 backdrop-blur sm:px-6">
          <div className="flex items-center gap-2">
            <Sheet open={menuOpen} onOpenChange={setMenuOpen}>
              <SheetTrigger asChild>
                <Button variant="ghost" size="icon" className="lg:hidden" aria-label={t.common.menu}>
                  <Menu className="h-5 w-5" />
                </Button>
              </SheetTrigger>
              <SheetContent side="left" className="w-64 border-r-0 bg-slate-900 p-0 text-slate-100">
                {/* Radix requires a title for the dialog; it is visually hidden
                    because the brand block below already names the app. */}
                <SheetTitle className="sr-only">{t.common.menu}</SheetTitle>
                <div className="flex h-full flex-col">
                  <Brand onNavigate={() => setMenuOpen(false)} />
                  <SidebarNav items={nav} onNavigate={() => setMenuOpen(false)} />
                  <MqttFooter />
                </div>
              </SheetContent>
            </Sheet>
            {/* The drawer hides the brand on small screens, so the header
                carries the current section instead of an empty gutter. */}
            <span className="text-sm font-semibold text-foreground lg:hidden">
              {nav.find((n) => (n.end ? location.pathname === n.to : location.pathname.startsWith(n.to)))?.label ??
                t.appName}
            </span>
          </div>
          <div className="flex items-center gap-2 sm:gap-3">
            {me.data?.user && (
              <span className="hidden items-center gap-2 text-sm text-muted-foreground sm:flex">
                <UserCircle className="h-4 w-4" />
                {me.data.user.name}
                <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">
                  {me.data.user.role}
                </span>
              </span>
            )}
            {me.data?.user && (
              <Button variant="ghost" size="sm" className="gap-1.5" onClick={() => logout.mutate()}>
                <LogOut className="h-4 w-4" />
                <span className="hidden sm:inline">{t.auth.signOut}</span>
              </Button>
            )}
            <GlobalSearch />
            <ThemeToggle />
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-2">
                  <Languages className="h-4 w-4" />
                  <span className="hidden sm:inline">{lang === "en" ? t.lang.en : t.lang.mk}</span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => setLang("en")}>{t.lang.en}</DropdownMenuItem>
                <DropdownMenuItem onClick={() => setLang("mk")}>{t.lang.mk}</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </header>
        <main className="flex-1 p-4 sm:p-6">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
