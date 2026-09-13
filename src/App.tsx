import { Routes, Route, useLocation } from "react-router";
import { Toaster } from "@/components/ui/sonner";
import { Layout } from "@/components/Layout";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { trpc } from "@/providers/trpc";
import Dashboard from "@/pages/Dashboard";
import Gateways from "@/pages/Gateways";
import GatewayDetail from "@/pages/GatewayDetail";
import Meters from "@/pages/Meters";
import MeterDetail from "@/pages/MeterDetail";
import Alarms from "@/pages/Alarms";
import Reports from "@/pages/Reports";
import SiteDiagram from "@/pages/SiteDiagram";
import Ems from "@/pages/Ems";
import Ota from "@/pages/Ota";
import Settings from "@/pages/Settings";
import Admin from "@/pages/Admin";
import NotFound from "@/pages/NotFound";
import Login from "@/pages/Login";

export default function App() {
  // The boundary resets on navigation: a page that threw must not keep the
  // error state once the user has moved somewhere else.
  const location = useLocation();
  // v7/C1: gate the whole app behind the session. auth.me returns null for
  // anonymous callers (and in AUTH_REQUIRED=false demo mode it also returns
  // null — the server then ignores auth entirely, so let those through).
  const me = trpc.auth.me.useQuery(undefined, { retry: false, staleTime: 60_000 });

  if (me.isLoading) {
    return <div className="flex min-h-screen items-center justify-center text-muted-foreground">…</div>;
  }
  // Login screen only when the server enforces auth and there is no session.
  if (me.data?.authRequired && !me.data.user) {
    return (
      <>
        <Login />
        <Toaster richColors position="bottom-right" />
      </>
    );
  }

  return (
    <>
      <ErrorBoundary resetKey={location.pathname}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Dashboard />} />
            <Route path="/gateways" element={<Gateways />} />
            <Route path="/gateways/:id" element={<GatewayDetail />} />
            <Route path="/meters" element={<Meters />} />
            <Route path="/meters/:id" element={<MeterDetail />} />
            <Route path="/alarms" element={<Alarms />} />
            <Route path="/ems" element={<Ems />} />
            <Route path="/ota" element={<Ota />} />
            <Route path="/reports" element={<Reports />} />
            <Route path="/sites/:id/diagram" element={<SiteDiagram />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/admin" element={<Admin />} />
            {/* An unknown path used to render the dashboard, which hid broken
                links behind a page that looked fine. */}
            <Route path="*" element={<NotFound />} />
          </Route>
        </Routes>
      </ErrorBoundary>
      <Toaster richColors position="bottom-right" />
    </>
  );
}
