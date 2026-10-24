// Web Push handler, imported into the generated Workbox service worker.
// Pushes are payload-less on purpose (see docs/alarms.md): no alarm text sits
// at the push service. The notification just says there is something new and
// opens the alarms page, which loads the details with the user's session.
self.addEventListener("push", (event) => {
  event.waitUntil(
    self.registration.showNotification("Gateway Monitoring Platform", {
      body: "New alarm activity — tap to open",
      icon: "/icons/icon-192.png",
      badge: "/icons/icon-192.png",
      tag: "gateway-alarm",
      renotify: true,
      data: { url: "/alarms" },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ("focus" in c) {
          c.navigate(url);
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
