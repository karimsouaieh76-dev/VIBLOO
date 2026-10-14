import webpush from "web-push";

// Web Push for the installed web app. VAPID keys come from the environment or
// are generated once and kept in the database, so subscriptions survive restarts.
export async function createPush(db) {
  let publicKey = process.env.VAPID_PUBLIC_KEY;
  let privateKey = process.env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) {
    publicKey = await db.getSetting("vapid_public");
    privateKey = await db.getSetting("vapid_private");
    if (!publicKey || !privateKey) {
      ({ publicKey, privateKey } = webpush.generateVAPIDKeys());
      await db.setSetting("vapid_public", publicKey);
      await db.setSetting("vapid_private", privateKey);
    }
  }
  const subject = process.env.VAPID_SUBJECT || "mailto:vibloo@example.org";
  webpush.setVapidDetails(subject, publicKey, privateKey);

  return {
    publicKey,
    async send(userIds, payload) {
      const subs = await db.pushSubscriptionsFor(userIds);
      await Promise.all(subs.map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            JSON.stringify(payload),
            { TTL: 60 * 60 * 24, urgency: "high", topic: payload.tag },
          );
        } catch (err) {
          // The browser dropped this subscription (app removed, permission revoked).
          if (err.statusCode === 404 || err.statusCode === 410) await db.deletePushSubscription(s.endpoint);
          else console.error("Notifica non inviata:", err.statusCode ?? err.message);
        }
      }));
    },
  };
}

export function notificationText(message, conversation) {
  const att = message.attachment;
  if (message.kind === "call") return { title: message.username, body: "📞 Chiamata" };
  let body = message.text;
  if (att) {
    const label = message.kind === "image" ? "📷 Foto" : message.kind === "audio" ? "🎤 Messaggio vocale" : `📎 ${att.name}`;
    body = message.text ? `${label} · ${message.text}` : label;
  }
  if (conversation.isGroup) return { title: conversation.name, body: `${message.username}: ${body}` };
  return { title: message.username, body };
}
