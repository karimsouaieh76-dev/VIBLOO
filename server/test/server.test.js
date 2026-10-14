import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { io as connect } from "socket.io-client";
import { createServer } from "../src/app.js";

let server, base;
const sockets = [];

before(async () => {
  // TEST_DATABASE_URL runs the same tests against Postgres.
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
    method,
    headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) },
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
const next = (socket, event) => new Promise((r) => socket.once(event, r));

test("registrazione, login e validazione", async () => {
  assert.equal((await register("anna")).status, 201);
  assert.equal((await register("ANNA")).status, 409);
  assert.equal((await register("x")).status, 400);
  assert.equal((await call("POST", "/api/login", null, { username: "anna", password: "sbagliata" })).status, 401);
  const { token } = await call("POST", "/api/login", null, { username: "Anna", password: "password123" });
  assert.equal((await call("GET", "/api/me", token)).user.username, "anna");
  assert.equal((await call("GET", "/api/me", "token-falso")).status, 401);
});

test("chat privata: messaggi, spunte, non letti, scrittura e presenza", async () => {
  const bruno = await register("bruno");
  const carla = await register("carla");
  const dario = await register("dario");

  const found = await call("GET", "/api/users?q=car", bruno.token);
  assert.deepEqual(found.users.map((u) => u.username), ["carla"]);

  const sb = await socketFor(bruno.token);
  const carlaOnline = next(sb, "presence");
  const sc = await socketFor(carla.token);
  assert.deepEqual(await carlaOnline, { userId: carla.user.id, online: true, lastSeen: null });

  const newConv = next(sc, "conversation:new");
  const opened = await call("POST", "/api/conversations", bruno.token, { userId: carla.user.id });
  assert.equal(opened.status, 201);
  const conv = opened.conversation;
  assert.equal(conv.isGroup, false);
  assert.equal((await newConv).id, conv.id);

  // Opening it again reuses the same chat, from either side.
  const again = await call("POST", "/api/conversations", carla.token, { userId: bruno.user.id });
  assert.equal(again.status, 200);
  assert.equal(again.conversation.id, conv.id);

  const typing = next(sc, "typing");
  sb.emit("typing", { conversationId: conv.id, typing: true });
  assert.equal((await typing).user.username, "bruno");

  const incoming = next(sc, "message:new");
  const ack = await sb.emitWithAck("message:send", { conversationId: conv.id, text: "  Ciao Carla!  " });
  assert.equal(ack.message.text, "Ciao Carla!");
  const msg = await incoming;
  assert.equal(msg.username, "bruno");

  let list = await call("GET", "/api/conversations", carla.token);
  assert.equal(list.conversations[0].unread, 1);
  assert.equal(list.conversations[0].lastMessage.text, "Ciao Carla!");
  assert.equal(list.conversations[0].members.find((m) => m.id === bruno.user.id).online, true);

  const delivered = next(sb, "receipt");
  sc.emit("delivered", { conversationId: conv.id, messageId: msg.id });
  assert.deepEqual(await delivered, { conversationId: conv.id, userId: carla.user.id, lastReadId: 0, lastDeliveredId: msg.id });

  const read = next(sb, "receipt");
  sc.emit("read", { conversationId: conv.id, messageId: msg.id });
  assert.equal((await read).lastReadId, msg.id);
  list = await call("GET", "/api/conversations", carla.token);
  assert.equal(list.conversations[0].unread, 0);

  // Outsiders can neither read nor write the chat.
  assert.equal((await call("GET", `/api/conversations/${conv.id}/messages`, dario.token)).status, 404);
  const sd = await socketFor(dario.token);
  assert.ok((await sd.emitWithAck("message:send", { conversationId: conv.id, text: "intruso" })).error);
  assert.ok((await sb.emitWithAck("message:send", { conversationId: conv.id, text: "   " })).error);

  const history = await call("GET", `/api/conversations/${conv.id}/messages?before=abc`, carla.token);
  assert.deepEqual(history.messages.map((m) => m.text), ["Ciao Carla!"]);

  const offline = next(sb, "presence");
  sc.close();
  const p = await offline;
  assert.equal(p.online, false);
  assert.ok(p.lastSeen > 0);
});

test("gruppi", async () => {
  const e = await register("elena");
  const f = await register("franco");
  const g = await register("gina");
  assert.equal((await call("POST", "/api/conversations", e.token, { name: "Calcetto", userIds: [] })).status, 400);
  assert.equal((await call("POST", "/api/conversations", e.token, { name: "", userIds: [f.user.id] })).status, 400);

  const sg = await socketFor(g.token);
  const created = await call("POST", "/api/conversations", e.token, { name: "Calcetto", userIds: [f.user.id, g.user.id] });
  assert.equal(created.status, 201);
  assert.equal(created.conversation.isGroup, true);
  assert.equal(created.conversation.members.length, 3);

  const incoming = next(sg, "message:new");
  const se = await socketFor(e.token);
  await se.emitWithAck("message:send", { conversationId: created.conversation.id, text: "Giovedì alle 20?" });
  assert.equal((await incoming).text, "Giovedì alle 20?");

  const list = await call("GET", "/api/conversations", f.token);
  assert.equal(list.conversations[0].name, "Calcetto");
  assert.equal(list.conversations[0].unread, 1);
});
