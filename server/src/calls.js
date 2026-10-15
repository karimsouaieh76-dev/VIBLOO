import { randomUUID } from "node:crypto";

const RING_TIMEOUT = Number(process.env.CALL_RING_TIMEOUT_MS) || 45 * 1000;
// While a call rings, the phone gets a fresh notification this often, so it
// keeps sounding and vibrating like a ringtone instead of chiming once.
const ringRepeat = () => Number(process.env.CALL_RING_REPEAT_MS) || 6 * 1000;

// Voice and video calls between two people. Audio and video travel directly
// between the two devices (WebRTC); the server only rings, relays the
// connection setup and writes the call into the chat history.
export function createCalls({ io, db, push, isLooking, userRoom }) {
  const calls = new Map(); // callId -> call
  const activeByUser = new Map(); // userId -> callId (ringing or in progress)

  const toSocket = (socketId, event, payload) => io.to(socketId).emit(event, payload);

  // A call leaves one line in the chat, e.g. "Chiamata vocale · 2:31" or "Chiamata persa".
  async function logCall(call, status) {
    const duration = call.answeredAt ? Math.round((Date.now() - call.answeredAt) / 1000) : 0;
    const text = JSON.stringify({ media: call.media, status, duration });
    const message = await db.addMessage(call.conversationId, call.from.id, text, null, "call");
    for (const id of [call.from.id, call.to.id]) io.to(userRoom(id)).emit("message:new", message);
    if (status === "missed" && !isLooking(call.to.id)) {
      await push.send([call.to.id], {
        title: call.from.username,
        body: call.media === "video" ? "📹 Videochiamata persa" : "📞 Chiamata persa",
        conversationId: call.conversationId,
        tag: `c${call.conversationId}`,
        callId: call.id,
      });
    }
  }

  async function end(call, reason, byUserId) {
    if (!calls.has(call.id)) return;
    clearTimeout(call.timer);
    clearInterval(call.ringer);
    calls.delete(call.id);
    for (const id of [call.from.id, call.to.id]) if (activeByUser.get(id) === call.id) activeByUser.delete(id);
    const payload = { callId: call.id, reason };
    // Everyone on both sides hears about it (all devices of the callee were ringing).
    io.to(userRoom(call.from.id)).emit("call:ended", payload);
    io.to(userRoom(call.to.id)).emit("call:ended", payload);
    const status = call.answeredAt ? "completed" : reason === "declined" ? "declined" : reason === "busy" ? "busy" : "missed";
    if (status !== "busy") await logCall(call, status).catch((err) => console.error(err));
    void byUserId;
  }

  const incomingPayload = (call) => ({
    callId: call.id, conversationId: call.conversationId, media: call.media, from: call.from,
  });

  function attach(socket, user, handle) {
    // Reopening the app (e.g. from the call notification) while it still rings.
    for (const call of calls.values()) {
      if (call.to.id === user.id && !call.answeredAt) socket.emit("call:incoming", incomingPayload(call));
    }

    handle("call:invite", async ({ conversationId, media }, reply) => {
      const convId = Number(conversationId);
      const kind = media === "video" ? "video" : "audio";
      if (!Number.isInteger(convId) || !(await db.isMember(convId, user.id))) return reply({ error: "Chat non trovata." });
      const meta = await db.conversationMeta(convId);
      if (meta.isGroup) return reply({ error: "Per ora si può chiamare solo una persona alla volta." });
      const otherId = (await db.memberIds(convId)).find((id) => id !== user.id);
      const other = otherId && (await db.findUserById(otherId));
      if (!other) return reply({ error: "Persona non trovata." });
      if ((await db.memberStatus(convId, user.id)) !== "accepted") return reply({ error: "Accetta la richiesta per poter chiamare." });
      if (await db.eitherBlocked(user.id, other.id)) return reply({ error: "Non puoi chiamare questa persona." });
      if ((await db.memberStatus(convId, other.id)) !== "accepted") {
        return reply({ error: `Potrai chiamare ${other.username} quando avrà accettato la tua richiesta di messaggio.` });
      }
      if (activeByUser.has(user.id)) return reply({ error: "Sei già in una chiamata." });

      const call = {
        id: randomUUID(), conversationId: convId, media: kind,
        from: { id: user.id, username: user.username, avatarAt: (await db.findUserById(user.id))?.avatarAt ?? null },
        to: { id: other.id, username: other.username, avatarAt: other.avatarAt ?? null },
        callerSocket: socket.id, calleeSocket: null, answeredAt: null, timer: null, ringer: null,
      };
      if (activeByUser.has(other.id)) {
        calls.set(call.id, call);
        reply({ callId: call.id });
        return end(call, "busy");
      }
      calls.set(call.id, call);
      activeByUser.set(user.id, call.id);
      activeByUser.set(other.id, call.id);
      call.timer = setTimeout(() => end(call, "missed"), RING_TIMEOUT);
      reply({ callId: call.id, to: call.to });

      io.to(userRoom(other.id)).emit("call:incoming", incomingPayload(call));
      // Always notify: a phone that just closed the app may still look "on screen".
      // A late notification is useless, so each one expires with the ringing.
      const startedAt = Date.now();
      let ring = 0;
      const ringPush = () => {
        const left = Math.ceil((startedAt + RING_TIMEOUT - Date.now()) / 1000);
        if (left <= 1 || !calls.has(call.id) || call.answeredAt) return clearInterval(call.ringer);
        ring += 1;
        push.send([other.id], {
          title: user.username,
          body: kind === "video" ? "📹 Videochiamata in arrivo" : "📞 Chiamata in arrivo",
          conversationId: convId,
          tag: `r${ring}-${call.id.slice(0, 8)}`,
          callId: call.id,
          call: true,
        }, { ttl: left }).catch((err) => console.error(err));
      };
      ringPush();
      call.ringer = setInterval(ringPush, ringRepeat());
    });

    handle("call:accept", async ({ callId }, reply) => {
      const call = calls.get(callId);
      if (!call || call.to.id !== user.id || call.answeredAt) return reply({ error: "La chiamata è già terminata." });
      clearTimeout(call.timer);
      clearInterval(call.ringer);
      call.answeredAt = Date.now();
      call.calleeSocket = socket.id;
      reply({ ok: true, media: call.media, from: call.from });
      toSocket(call.callerSocket, "call:accepted", { callId });
      // Stop the ringing on the callee's other devices.
      socket.to(userRoom(user.id)).emit("call:ended", { callId, reason: "answered_elsewhere" });
    });

    handle("call:decline", async ({ callId }, reply) => {
      const call = calls.get(callId);
      if (call && call.to.id === user.id && !call.answeredAt) await end(call, "declined", user.id);
      reply({ ok: true });
    });

    // `reason` tells the other side the call could not connect (shown to both).
    handle("call:hangup", async ({ callId, reason }, reply) => {
      const call = calls.get(callId);
      const why = reason === "failed" || reason === "no_route" ? reason : "hangup";
      if (call && (call.from.id === user.id || call.to.id === user.id)) await end(call, why, user.id);
      reply({ ok: true });
    });

    // Connection setup (SDP offers/answers and ICE candidates), passed to the other device.
    handle("call:signal", async ({ callId, data }) => {
      const call = calls.get(callId);
      if (!call || !call.answeredAt) return;
      if (socket.id === call.callerSocket) toSocket(call.calleeSocket, "call:signal", { callId, data });
      else if (socket.id === call.calleeSocket) toSocket(call.callerSocket, "call:signal", { callId, data });
    });

    // Why a call did not connect, for the server logs (ICE states and candidate types).
    socket.on("call:diag", (d) => {
      try { console.log("Chiamata non collegata:", JSON.stringify(d).slice(0, 600)); } catch { /* ignore */ }
    });

    socket.on("disconnect", () => {
      for (const call of calls.values()) {
        if (call.callerSocket === socket.id || call.calleeSocket === socket.id) end(call, "disconnected", user.id);
      }
    });
  }

  return { attach, active: () => calls.size };
}

// STUN finds each device's public address; TURN relays voice and video when
// a direct path is impossible (common on 4G/5G). TURN comes from, in order:
// Cloudflare Realtime, Metered.ca, or fixed TURN_URLS/USERNAME/CREDENTIAL.
const STUN = { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] };
let cached = null; // { servers, until }

async function fetchTurn() {
  const env = process.env;
  if (env.CLOUDFLARE_TURN_KEY_ID && env.CLOUDFLARE_TURN_API_TOKEN) {
    const res = await fetch(
      `https://rtc.live.cloudflare.com/v1/turn/keys/${env.CLOUDFLARE_TURN_KEY_ID}/credentials/generate-ice-servers`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${env.CLOUDFLARE_TURN_API_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ ttl: 86400 }),
      });
    if (!res.ok) throw new Error(`Cloudflare TURN ${res.status}`);
    const body = await res.json();
    const list = Array.isArray(body.iceServers) ? body.iceServers : [body.iceServers];
    return { servers: list, ttl: 12 * 3600 * 1000 };
  }
  if (env.METERED_DOMAIN && env.METERED_API_KEY) {
    const res = await fetch(`https://${env.METERED_DOMAIN}/api/v1/turn/credentials?apiKey=${encodeURIComponent(env.METERED_API_KEY)}`);
    if (!res.ok) throw new Error(`Metered TURN ${res.status}`);
    return { servers: await res.json(), ttl: 3600 * 1000 };
  }
  if (env.TURN_URLS) {
    return {
      servers: [{
        urls: env.TURN_URLS.split(",").map((s) => s.trim()).filter(Boolean),
        username: env.TURN_USERNAME ?? "",
        credential: env.TURN_CREDENTIAL ?? "",
      }],
      ttl: Infinity,
    };
  }
  return { servers: [], ttl: Infinity };
}

export async function iceServers() {
  if (!cached || cached.until < Date.now()) {
    try {
      const { servers, ttl } = await fetchTurn();
      cached = { servers, until: Date.now() + ttl };
    } catch (err) {
      console.error("TURN non disponibile:", err.message);
      cached = { servers: [], until: Date.now() + 60 * 1000 };
    }
  }
  const turn = cached.servers;
  const hasTurn = turn.some((s) => [].concat(s.urls ?? s.url ?? []).some((u) => /^turns?:/.test(u)));
  return { iceServers: [STUN, ...turn], hasTurn };
}
