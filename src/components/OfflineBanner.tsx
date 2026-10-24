// Shown while the browser is offline. The app shell keeps working from the
// service-worker cache, but plant data is never served stale — say so.
import { useEffect, useState } from "react";
import { WifiOff } from "lucide-react";
import { useI18n } from "@/i18n";

export function OfflineBanner() {
  const { t } = useI18n();
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine);
  useEffect(() => {
    const up = () => setOnline(true);
    const down = () => setOnline(false);
    window.addEventListener("online", up);
    window.addEventListener("offline", down);
    return () => {
      window.removeEventListener("online", up);
      window.removeEventListener("offline", down);
    };
  }, []);
  if (online) return null;
  return (
    <div role="status" className="flex items-center gap-2 bg-amber-500 px-4 py-1.5 text-sm font-medium text-amber-950">
      <WifiOff className="h-4 w-4" /> {t.pwa.offline}
    </div>
  );
}
