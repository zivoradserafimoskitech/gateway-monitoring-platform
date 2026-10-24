// Browser side of Web Push. Produces the PushSubscription JSON that a
// "web push" notification channel stores as its target (docs/alarms.md).
// The VAPID public key comes from VITE_VAPID_PUBLIC_KEY at build time.

export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64.length % 4)) % 4);
  const b64 = (base64 + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

export function pushSupported(): boolean {
  return typeof window !== "undefined" && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

export async function subscribePush(vapidPublicKey: string | undefined = import.meta.env.VITE_VAPID_PUBLIC_KEY): Promise<string> {
  if (!pushSupported()) throw new Error("This browser does not support push notifications");
  if (!vapidPublicKey) throw new Error("VITE_VAPID_PUBLIC_KEY is not configured for this build");
  const perm = await Notification.requestPermission();
  if (perm !== "granted") throw new Error("Notification permission was not granted");
  const reg = await navigator.serviceWorker.ready;
  const existing = await reg.pushManager.getSubscription();
  const sub =
    existing ??
    (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(vapidPublicKey) }));
  return JSON.stringify(sub.toJSON());
}
