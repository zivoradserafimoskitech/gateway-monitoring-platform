// §8: every unknown path silently rendered the dashboard, so a mistyped or
// stale link looked like a working page showing the wrong thing.
import { Link } from "react-router";
import { useI18n } from "@/i18n";
import { Button } from "@/components/ui/button";
import { Compass } from "lucide-react";

export default function NotFound() {
  const { t } = useI18n();
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3 text-center">
      <Compass className="h-10 w-10 text-slate-300" />
      <h1 className="text-2xl font-bold tracking-tight">{t.common.notFoundTitle}</h1>
      <p className="max-w-md text-sm text-slate-500">{t.common.notFoundHint}</p>
      <Button asChild variant="outline">
        <Link to="/">{t.common.backToDashboard}</Link>
      </Button>
    </div>
  );
}
