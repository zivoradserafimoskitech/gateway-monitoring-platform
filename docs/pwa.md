# PWA, mobile and field commissioning

The web app is an installable Progressive Web App (`vite-plugin-pwa`).

- **Install:** "Add to home screen" on Android/iOS, or the install icon in
  Chrome/Edge. Manifest: name *Gateway Monitoring Platform*, standalone,
  theme `#0f172a`, icons in `public/icons/`, shortcuts to Alarms and
  Commissioning.
- **Offline:** the app shell (JS/CSS/HTML/icons) is precached by a Workbox
  service worker with `/index.html` as navigation fallback. `/api/*`,
  `/metrics`, `/healthz`, `/readyz` are **never** cached — plant data and
  control always need a live connection. An offline banner says so.
- **Updates:** `registerType: autoUpdate`; `sw.js` and the manifest are served
  with `Cache-Control: no-cache` (`api/lib/vite.ts`).
- **Push:** `public/push-sw.js` handles payload-less Web Push (see
  docs/alarms.md). Settings → Notifications → *Enable push on this device*
  subscribes the browser and copies the PushSubscription JSON, to be pasted
  into a *web push* channel (channel type added in the alarms PR). Build with
  `VITE_VAPID_PUBLIC_KEY=<same public key as VAPID_PUBLIC_KEY>`.
- **Mobile layout:** below `lg` a bottom tab bar (Dashboard, Alarms,
  Commissioning, Gateways) with safe-area padding; the drawer keeps the full
  menu.
- **QR / barcode serial scan:** `QrScanButton` uses the browser
  `BarcodeDetector` (QR, Data Matrix, Code 128/39, EAN-13) with the rear
  camera. Used in Admin → Device registrations (fills the UID) and on the
  Commissioning page (finds the gateway by serial, selects its site, links to
  it). `parseScannedSerial` understands bare serials, `SN:` / `S/N` / `Serial
  No.` labels and vendor URLs with `?sn=`. Browsers without BarcodeDetector
  get a clear message and the serial is typed.
