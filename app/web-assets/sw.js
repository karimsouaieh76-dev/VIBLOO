// Vibloo service worker: shows push notifications and opens the right chat
// when one is tapped.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: "Vibloo", body: event.data?.text() }; }
  event.waitUntil(
    self.registration.showNotification(data.title || "Vibloo", {
      body: data.body || "Nuovo messaggio",
      tag: data.tag,
      renotify: Boolean(data.tag),
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { conversationId: data.conversationId },
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const conversationId = event.notification.data?.conversationId;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    const existing = windows[0];
    if (existing) {
      await existing.focus();
      existing.postMessage({ type: "open-chat", conversationId });
      return;
    }
    await self.clients.openWindow(conversationId ? `/?chat=${conversationId}` : "/");
  })());
});
