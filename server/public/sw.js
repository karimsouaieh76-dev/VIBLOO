// Vibloo service worker: shows push notifications and opens the right chat
// when one is tapped.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

// Removes the "incoming call" notifications of a call, so a ringing call
// shows one notification at a time and none once it is over.
async function closeCallNotifications(callId) {
  if (!callId) return;
  const shown = await self.registration.getNotifications();
  for (const n of shown) if (n.data?.callId === callId) n.close();
}

self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { title: "Vibloo", body: event.data?.text() }; }
  event.waitUntil((async () => {
    // Every new ring replaces the previous one, and the phone sounds again.
    await closeCallNotifications(data.callId).catch(() => {});
    await self.registration.showNotification(data.title || "Vibloo", {
      body: data.body || "Nuovo messaggio",
      tag: data.tag,
      renotify: Boolean(data.tag),
      silent: false,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { conversationId: data.conversationId, callId: data.call ? data.callId : undefined },
      // Incoming calls stay on screen and vibrate like a phone call.
      requireInteraction: Boolean(data.call),
      vibrate: data.call ? [800, 300, 800, 300, 800, 300, 800] : [200, 100, 200],
    });
  })());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const { conversationId, callId } = event.notification.data ?? {};
  event.waitUntil((async () => {
    await closeCallNotifications(callId).catch(() => {});
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
