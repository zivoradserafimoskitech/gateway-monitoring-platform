import { Routes, Route } from "react-router";
import { Toaster } from "@/components/ui/sonner";
import { Layout } from "@/components/Layout";
import { trpc } from "@/providers/trpc";
import Dashboard from "@/pages/Dashboard";
import Gateways from "@/pages/Gateways";
import GatewayDetail from "@/pages/GatewayDetail";
import Meters from "@/pages/Meters";
import MeterDetail from "@/pages/MeterDetail";
import Alarms from "@/pages/Alarms";
import Reports from "@/pages/Reports";
import SiteDiagram from "@/pages/SiteDiagram";
import Settings from "@/pages/Settings";
import Login from "@/pages/Login";

export default function App() {
  // v7/C1: gate the whole app behind the session. auth.me returns null for
  // anonymous callers (and in AUTH_REQUIRED=false demo mode it also returns
  // null — the server then ignores auth entirely, so let those through).
  const me = trpc.auth.me.useQuery(undefined, { retry: false, staleTime: 60_000 });

  if (me.isLoading) {
    return <div className="flex min-h-screen items-center justify-center text-slate-400">…</div>;
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
      <Routes>
        <Route element={<Layout />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/gateways" element={<Gateways />} />
          <Route path="/gateways/:id" element={<GatewayDetail />} />
          <Route path="/meters" element={<Meters />} />
          <Route path="/meters/:id" element={<MeterDetail />} />
          <Route path="/alarms" element={<Alarms />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/sites/:id/diagram" element={<SiteDiagram />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Dashboard />} />
        </Route>
      </Routes>
      <Toaster richColors position="bottom-right" />
    </>
  );
}
