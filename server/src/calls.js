import { randomUUID } from "node:crypto";

const RING_TIMEOUT = Number(process.env.CALL_RING_TIMEOUT_MS) || 45 * 1000;

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
      });
    }
  }

  async function end(call, reason, byUserId) {
    if (!calls.has(call.id)) return;
    clearTimeout(call.timer);
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
        callerSocket: socket.id, calleeSocket: null, answeredAt: null, timer: null,
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
      // A late notification is useless, so it expires with the ringing.
      push.send([other.id], {
        title: user.username,
        body: kind === "video" ? "📹 Videochiamata in arrivo" : "📞 Chiamata in arrivo",
        conversationId: convId,
        tag: `call-${call.id}`,
        call: true,
      }, { ttl: Math.ceil(RING_TIMEOUT / 1000) }).catch((err) => console.error(err));
    });

    handle("call:accept", async ({ callId }, reply) => {
      const call = calls.get(callId);
      if (!call || call.to.id !== user.id || call.answeredAt) return reply({ error: "La chiamata è già terminata." });
      clearTimeout(call.timer);
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

    handle("call:hangup", async ({ callId }, reply) => {
      const call = calls.get(callId);
      if (call && (call.from.id === user.id || call.to.id === user.id)) await end(call, "hangup", user.id);
      reply({ ok: true });
    });

    // Connection setup (SDP offers/answers and ICE candidates), passed to the other device.
    handle("call:signal", async ({ callId, data }) => {
      const call = calls.get(callId);
      if (!call || !call.answeredAt) return;
      if (socket.id === call.callerSocket) toSocket(call.calleeSocket, "call:signal", { callId, data });
      else if (socket.id === call.calleeSocket) toSocket(call.callerSocket, "call:signal", { callId, data });
    });

    socket.on("disconnect", () => {
      for (const call of calls.values()) {
        if (call.callerSocket === socket.id || call.calleeSocket === socket.id) end(call, "disconnected", user.id);
      }
    });
  }

  return { attach, active: () => calls.size };
}

// STUN finds each device's public address; TURN relays the media when a
// direct path is impossible (some mobile networks). TURN is optional.
export function iceServers() {
  const servers = [{ urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] }];
  if (process.env.TURN_URLS) {
    servers.push({
      urls: process.env.TURN_URLS.split(",").map((s) => s.trim()).filter(Boolean),
      username: process.env.TURN_USERNAME ?? "",
      credential: process.env.TURN_CREDENTIAL ?? "",
    });
  }
  return servers;
}
