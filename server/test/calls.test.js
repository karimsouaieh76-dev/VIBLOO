import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { io as connect } from "socket.io-client";

process.env.CALL_RING_TIMEOUT_MS = "400";
const { createServer } = await import("../src/app.js");

let server, base;
const sockets = [];
before(async () => {
  server = await createServer({ dbFile: ":memory:", secret: "test-secret", inviteOnly: false });
  await new Promise((r) => server.httpServer.listen(0, r));
  base = `http://127.0.0.1:${server.httpServer.address().port}`;
});
after(async () => {
  sockets.forEach((s) => s.close());
  server.io.close();
  server.httpServer.close();
  await server.db.close();
});

const call = async (method, path, token, body) =>
  (await fetch(base + path, {
    method, headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  })).json();
const socketFor = async (token) => {
  const s = connect(base, { auth: { token }, transports: ["websocket"] });
  sockets.push(s);
  await new Promise((r) => s.on("connect", r));
  return s;
};
const next = (s, event, filter = () => true) => new Promise((r) => {
  const h = (p) => { if (filter(p)) { s.off(event, h); r(p); } };
  s.on(event, h);
});
const callLog = (m) => ({ ...JSON.parse(m.text), kind: m.kind });

let n = 0;
async function pair() {
  n += 1;
  const a = await call("POST", "/api/register", null, { username: `alfa${n}`, password: "password123" });
  const b = await call("POST", "/api/register", null, { username: `beta${n}`, password: "password123" });
  const { conversation } = await call("POST", "/api/conversations", a.token, { userId: b.user.id });
  await call("POST", `/api/conversations/${conversation.id}/accept`, b.token, {});
  return { a, b, conv: conversation.id, sa: await socketFor(a.token), sb: await socketFor(b.token) };
}

test("videochiamata: squillo, risposta, scambio dati, fine e storico", async () => {
  const { a, b, conv, sa, sb } = await pair();
  const cfg = await call("GET", "/api/call-config", a.token);
  assert.ok(cfg.iceServers[0].urls.some((u) => u.startsWith("stun:")));

  const ringing = next(sb, "call:incoming");
  const { callId, to } = await sa.emitWithAck("call:invite", { conversationId: conv, media: "video" });
  assert.equal(to.username, b.user.username);
  const incoming = await ringing;
  assert.deepEqual(incoming, { callId, conversationId: conv, media: "video", from: { id: a.user.id, username: a.user.username, avatarAt: null } });

  const accepted = next(sa, "call:accepted");
  assert.equal((await sb.emitWithAck("call:accept", { callId })).ok, true);
  await accepted;

  const offer = next(sb, "call:signal");
  sa.emit("call:signal", { callId, data: { type: "offer", sdp: "v=0..." } });
  assert.equal((await offer).data.type, "offer");
  const answer = next(sa, "call:signal");
  sb.emit("call:signal", { callId, data: { type: "answer", sdp: "v=0..." } });
  assert.equal((await answer).data.type, "answer");

  await new Promise((r) => setTimeout(r, 1100));
  const ended = next(sb, "call:ended");
  const logged = next(sb, "message:new", (m) => m.kind === "call");
  sa.emit("call:hangup", { callId });
  assert.equal((await ended).reason, "hangup");
  const log = callLog(await logged);
  assert.equal(log.status, "completed");
  assert.equal(log.media, "video");
  assert.ok(log.duration >= 1);
  assert.ok((await sa.emitWithAck("message:edit", { messageId: (await server.db.messages(conv)).at(-1).id, text: "x" })).error);
});

test("chiamata rifiutata, persa e occupato", async () => {
  const { conv, sa, sb, b } = await pair();

  let r = await sa.emitWithAck("call:invite", { conversationId: conv, media: "audio" });
  const declinedLog = next(sa, "message:new", (m) => m.kind === "call");
  const declined = next(sa, "call:ended");
  sb.emit("call:decline", { callId: r.callId });
  assert.equal((await declined).reason, "declined");
  assert.equal(callLog(await declinedLog).status, "declined");

  const missedLog = next(sb, "message:new", (m) => m.kind === "call" && JSON.parse(m.text).status === "missed");
  r = await sa.emitWithAck("call:invite", { conversationId: conv, media: "audio" });
  assert.equal((await next(sa, "call:ended", (p) => p.callId === r.callId)).reason, "missed");
  assert.equal(callLog(await missedLog).status, "missed");
  const list = await call("GET", "/api/conversations", b.token);
  assert.equal(list.conversations.find((c) => c.id === conv).lastMessage.kind, "call");

  // Beta is still ringing for Alfa: a third person gets "busy" straight away.
  const other = await pair();
  const { conversation: toBeta } = await call("POST", "/api/conversations", other.a.token, { userId: b.user.id });
  await call("POST", `/api/conversations/${toBeta.id}/accept`, b.token, {});
  const ringing = await sa.emitWithAck("call:invite", { conversationId: conv, media: "audio" });
  assert.ok(ringing.callId);
  const busy = next(other.sa, "call:ended");
  await other.sa.emitWithAck("call:invite", { conversationId: toBeta.id, media: "audio" });
  assert.equal((await busy).reason, "busy");
  sa.emit("call:hangup", { callId: ringing.callId });
});

test("niente chiamate nei gruppi e niente intrusi", async () => {
  const { a, b, sa } = await pair();
  const { conversation: group } = await call("POST", "/api/conversations", a.token, { name: "Gruppo", userIds: [b.user.id] });
  assert.ok((await sa.emitWithAck("call:invite", { conversationId: group.id, media: "audio" })).error);
  const x = await pair();
  assert.ok((await x.sa.emitWithAck("call:invite", { conversationId: group.id, media: "audio" })).error);
});
