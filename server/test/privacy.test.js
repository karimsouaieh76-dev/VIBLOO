import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { io as connect } from "socket.io-client";
import { createServer } from "../src/app.js";

let server, base;
const sockets = [];
before(async () => {
  server = await createServer({ dbFile: ":memory:", databaseUrl: process.env.TEST_DATABASE_URL, secret: "test-secret" });
  await new Promise((r) => server.httpServer.listen(0, r));
  base = `http://127.0.0.1:${server.httpServer.address().port}`;
});
after(async () => {
  sockets.forEach((s) => s.close());
  server.io.close();
  server.httpServer.close();
  await server.db.close();
});

const call = async (method, path, token, body) => {
  const res = await fetch(base + path, {
    method, headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, ...(await res.json()) };
};
const register = (username) => call("POST", "/api/register", null, { username, password: "password123" });
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
const nothing = (s, event, ms = 400) => new Promise((r) => {
  const h = () => { s.off(event, h); r(false); };
  s.on(event, h);
  setTimeout(() => { s.off(event, h); r(true); }, ms);
});
const viewOf = async (token, id) => (await call("GET", "/api/conversations", token)).conversations.find((c) => c.id === id);

test("richieste di messaggio", async () => {
  const anna = await register("r_anna");
  const bea = await register("r_bea");
  const sa = await socketFor(anna.token);
  const sb = await socketFor(bea.token);

  const { conversation } = await call("POST", "/api/conversations", anna.token, { userId: bea.user.id });
  const id = conversation.id;
  assert.equal((await viewOf(anna.token, id)).myStatus, "accepted");
  assert.equal((await viewOf(bea.token, id)).myStatus, "pending");

  // Anna can write; Bea cannot answer or call before accepting.
  await sa.emitWithAck("message:send", { conversationId: id, text: "Ciao, sono Anna" });
  assert.ok((await sb.emitWithAck("message:send", { conversationId: id, text: "chi sei?" })).error);
  assert.ok((await sa.emitWithAck("call:invite", { conversationId: id, media: "audio" })).error.includes("accettato"));
  assert.ok((await sb.emitWithAck("call:invite", { conversationId: id, media: "audio" })).error);

  // Reading a request reveals nothing to the sender.
  const msgId = (await viewOf(bea.token, id)).lastMessage.id;
  sb.emit("read", { conversationId: id, messageId: msgId });
  assert.ok(await nothing(sa, "receipt"), "nessuna spunta blu prima di accettare");
  const annaSees = (await viewOf(anna.token, id)).members.find((m) => m.id === bea.user.id);
  assert.equal(annaSees.lastReadId, 0);
  assert.equal(annaSees.online, false, "online nascosto finché non accetta");

  // Not a contact yet: no live presence either.
  assert.deepEqual((await call("GET", "/api/contacts", anna.token)).users, []);

  // Accept: now everything works and both see each other as contacts.
  const update = next(sa, "conversation:update");
  assert.equal((await call("POST", `/api/conversations/${id}/accept`, bea.token, {})).conversation.myStatus, "accepted");
  assert.equal((await update).members.find((m) => m.id === bea.user.id).online, true);
  assert.ok((await sb.emitWithAck("message:send", { conversationId: id, text: "Ciao Anna!" })).message);
  assert.deepEqual((await call("GET", "/api/contacts", anna.token)).users.map((u) => u.username), ["r_bea"]);
});

test("rifiutare una richiesta la nasconde senza avvisare chi scrive", async () => {
  const carlo = await register("r_carlo");
  const dina = await register("r_dina");
  const sc = await socketFor(carlo.token);
  const { conversation } = await call("POST", "/api/conversations", carlo.token, { userId: dina.user.id });
  await sc.emitWithAck("message:send", { conversationId: conversation.id, text: "Promo imperdibile!" });
  assert.equal((await call("POST", `/api/conversations/${conversation.id}/decline`, dina.token, {})).ok, true);
  assert.equal(await viewOf(dina.token, conversation.id), undefined);
  assert.ok(await viewOf(carlo.token, conversation.id), "chi scrive non sa del rifiuto");

  // Later messages do not reach her.
  const sd = await socketFor(dina.token);
  const silent = nothing(sd, "message:new");
  await sc.emitWithAck("message:send", { conversationId: conversation.id, text: "Ancora?" });
  assert.ok(await silent);

  // A group from a stranger also starts as a request.
  const ezio = await register("r_ezio");
  const { conversation: group } = await call("POST", "/api/conversations", carlo.token, { name: "Offerte", userIds: [dina.user.id, ezio.user.id] });
  assert.equal((await viewOf(dina.token, group.id)).myStatus, "pending");
});

test("bloccare una persona", async () => {
  const fede = await register("r_fede");
  const gigi = await register("r_gigi");
  const sf = await socketFor(fede.token);
  const sg = await socketFor(gigi.token);
  const { conversation } = await call("POST", "/api/conversations", fede.token, { userId: gigi.user.id });
  await call("POST", `/api/conversations/${conversation.id}/accept`, gigi.token, {});

  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  await fetch(`${base}/api/me/avatar`, { method: "PUT", headers: { authorization: `Bearer ${gigi.token}`, "content-type": "image/png" }, body: png });

  // Gigi blocks Fede: Fede sees Gigi offline and without photo, live.
  const hidden = next(sf, "presence", (p) => p.userId === gigi.user.id);
  assert.equal((await call("POST", "/api/blocks", gigi.token, { userId: fede.user.id })).ok, true);
  assert.equal((await hidden).online, false);
  assert.deepEqual((await call("GET", "/api/blocks", gigi.token)).users.map((u) => u.username), ["r_fede"]);

  assert.ok((await sf.emitWithAck("message:send", { conversationId: conversation.id, text: "ehi" })).error);
  assert.ok((await sf.emitWithAck("call:invite", { conversationId: conversation.id, media: "video" })).error);
  assert.ok((await sg.emitWithAck("message:send", { conversationId: conversation.id, text: "ciao" })).error.includes("sbloccala"));
  assert.equal((await call("POST", "/api/conversations", fede.token, { userId: gigi.user.id })).status, 403);
  assert.equal((await fetch(`${base}/api/users/${gigi.user.id}/avatar?token=${fede.token}`)).status, 404);
  const fedeSees = (await viewOf(fede.token, conversation.id)).members.find((m) => m.id === gigi.user.id);
  assert.equal(fedeSees.avatarAt, null);
  assert.equal(fedeSees.lastSeen, null);
  assert.equal((await viewOf(gigi.token, conversation.id)).blockedByMe, true);
  const typingSilent = nothing(sg, "typing");
  sf.emit("typing", { conversationId: conversation.id, typing: true });
  assert.ok(await typingSilent);
  // Gigi cannot be put in a group by Fede.
  assert.equal((await call("POST", "/api/conversations", fede.token, { name: "X", userIds: [gigi.user.id] })).status, 403);

  // Unblock: back to normal.
  await call("DELETE", `/api/blocks/${fede.user.id}`, gigi.token);
  assert.ok((await sf.emitWithAck("message:send", { conversationId: conversation.id, text: "pace?" })).message);
  assert.equal((await fetch(`${base}/api/users/${gigi.user.id}/avatar?token=${fede.token}`)).status, 200);
});

test("bloccare chi ha mandato una richiesta la elimina", async () => {
  const h = await register("r_hugo");
  const i = await register("r_ida");
  const { conversation } = await call("POST", "/api/conversations", h.token, { userId: i.user.id });
  await call("POST", "/api/blocks", i.token, { userId: h.user.id });
  assert.equal(await viewOf(i.token, conversation.id), undefined);
});
