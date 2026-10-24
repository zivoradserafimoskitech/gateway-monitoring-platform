// Camera QR / barcode scanner for device serials (commissioning in the field).
// Uses the browser's BarcodeDetector (Chrome/Edge on Android, Safari 17+ on
// iOS behind a flag, most installed PWAs). Where it is missing, the operator
// types the serial — the button simply explains why it cannot scan.
import { useEffect, useRef, useState } from "react";
import { ScanLine, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { parseScannedSerial } from "@/lib/scan-serial";
import { useI18n } from "@/i18n";

interface Detector {
  detect(src: HTMLVideoElement): Promise<Array<{ rawValue: string }>>;
}
type DetectorCtor = new (opts: { formats: string[] }) => Detector;

function detectorCtor(): DetectorCtor | null {
  const w = window as unknown as { BarcodeDetector?: DetectorCtor };
  return w.BarcodeDetector ?? null;
}

export function QrScanButton({ onSerial }: { onSerial: (serial: string) => void }) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (!open) return;
    let stream: MediaStream | null = null;
    let stop = false;
    const Ctor = detectorCtor();
    (async () => {
      try {
        if (!Ctor) throw new Error(t.pwa.scanUnsupported);
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        if (!video.current) return;
        video.current.srcObject = stream;
        await video.current.play();
        const det = new Ctor({ formats: ["qr_code", "data_matrix", "code_128", "code_39", "ean_13"] });
        while (!stop) {
          const codes = await det.detect(video.current).catch(() => []);
          for (const c of codes) {
            const serial = parseScannedSerial(c.rawValue);
            if (serial) {
              onSerial(serial);
              setOpen(false);
              return;
            }
          }
          await new Promise((r) => setTimeout(r, 250));
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      stop = true;
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, [open, onSerial, t.pwa.scanUnsupported]);

  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => (setError(null), setOpen(true))} aria-label={t.pwa.scan}>
        <ScanLine className="h-4 w-4" />
        <span className="ml-1">{t.pwa.scan}</span>
      </Button>
      {open ? (
        <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 bg-black/90 p-4">
          {error ? <p className="max-w-sm text-center text-sm text-white">{error}</p> : <video ref={video} className="max-h-[70vh] w-full max-w-md rounded" playsInline muted />}
          <p className="text-xs text-slate-300">{t.pwa.scanHint}</p>
          <Button variant="secondary" onClick={() => setOpen(false)}>
            <X className="mr-1 h-4 w-4" /> {t.common.cancel}
          </Button>
        </div>
      ) : null}
    </>
  );
}
