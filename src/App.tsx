import { Routes, Route } from "react-router";
import { Toaster } from "@/components/ui/sonner";
import { Layout } from "@/components/Layout";
import Dashboard from "@/pages/Dashboard";
import Gateways from "@/pages/Gateways";
import GatewayDetail from "@/pages/GatewayDetail";
import Meters from "@/pages/Meters";
import MeterDetail from "@/pages/MeterDetail";
import Alarms from "@/pages/Alarms";
import Reports from "@/pages/Reports";
import Settings from "@/pages/Settings";

export default function App() {
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
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Dashboard />} />
        </Route>
      </Routes>
      <Toaster richColors position="bottom-right" />
    </>
  );
}
