// "Enable push on this device": subscribes the browser and shows the
// subscription JSON to paste into a "web push" notification channel.
import { useState } from "react";
import { BellPlus } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { pushSupported, subscribePush } from "@/lib/push";
import { useI18n } from "@/i18n";

export function PushToggle() {
  const { t } = useI18n();
  const [sub, setSub] = useState<string | null>(null);
  if (!pushSupported()) return null;
  return (
    <div className="space-y-2">
      <Button
        variant="outline"
        size="sm"
        onClick={async () => {
          try {
            const s = await subscribePush();
            setSub(s);
            await navigator.clipboard?.writeText(s).catch(() => undefined);
            toast.success(t.pwa.pushCopied);
          } catch (e) {
            toast.error(e instanceof Error ? e.message : String(e));
          }
        }}
      >
        <BellPlus className="mr-1 h-4 w-4" /> {t.pwa.enablePush}
      </Button>
      {sub ? <textarea readOnly className="h-20 w-full rounded border bg-muted p-2 font-mono text-xs" value={sub} /> : null}
    </div>
  );
}
