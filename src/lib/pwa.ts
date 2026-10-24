// Service worker registration (vite-plugin-pwa). Production only: in dev the
// Vite server and a caching worker fight over module URLs.
export async function registerPwa(): Promise<void> {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  const { registerSW } = await import("virtual:pwa-register");
  registerSW({ immediate: true });
}
