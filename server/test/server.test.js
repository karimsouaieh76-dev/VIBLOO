import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { io as connect } from "socket.io-client";
import { createServer } from "../src/app.js";

let server, base;
const sockets = [];

before(async () => {
  // TEST_DATABASE_URL runs the same tests against Postgres.
  server = await createServer({ dbFile: ":memory:", databaseUrl: process.env.TEST_DATABASE_URL, secret: "test-secret", inviteOnly: false });
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

test("password corte ammesse, ma i tentativi sbagliati vengono frenati", async () => {
  const short = (username, password) => call("POST", "/api/register", null, { username, password });
  assert.equal((await short("corto", "abc")).status, 400);
  assert.equal((await short("corto", "1234")).status, 201);
  for (let i = 0; i < 10; i++) {
    assert.equal((await call("POST", "/api/login", null, { username: "corto", password: `x${i}xx` })).status, 401);
  }
  assert.equal((await call("POST", "/api/login", null, { username: "corto", password: "1234" })).status, 429);
});

test("chat privata: messaggi, spunte, non letti, scrittura e presenza", async () => {
  const bruno = await register("bruno");
  const carla = await register("carla");
  const dario = await register("dario");

  // Only the exact username finds someone.
  assert.deepEqual((await call("GET", "/api/users?q=car", bruno.token)).users, []);
  assert.deepEqual((await call("GET", "/api/users?q=", bruno.token)).users, []);
  const found = await call("GET", "/api/users?q=CARLA", bruno.token);
  assert.deepEqual(found.users.map((u) => u.username), ["carla"]);
  assert.equal(found.users[0].online, false, "gli sconosciuti non vedono chi è online");

  const sb = await socketFor(bruno.token);
  const sc = await socketFor(carla.token);

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

test("foto, vocali e file", async () => {
  const h = await register("ugo");
  const i = await register("ivana");
  const out = await register("zeno");
  const { conversation: conv } = await call("POST", "/api/conversations", h.token, { userId: i.user.id });

  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const upload = (token, body, type, name) => fetch(`${base}/api/conversations/${conv.id}/attachments`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": type, "x-file-name": encodeURIComponent(name), "x-width": "800", "x-height": "600" },
    body,
  }).then(async (r) => ({ status: r.status, ...(await r.json()) }));

  assert.equal((await upload(out.token, png, "image/png", "x.png")).status, 404);
  const up = await upload(h.token, png, "image/png", "vacanze è.png");
  assert.equal(up.status, 201);
  assert.deepEqual({ ...up.attachment, id: 0 }, { id: 0, mime: "image/png", name: "vacanze è.png", size: png.length, width: 800, height: 600, duration: null });

  // A JSON file is stored as a file, not parsed.
  const jsonFile = await upload(h.token, '{"a":1}', "application/json", "dati.json");
  assert.equal(jsonFile.status, 201);

  const sh = await socketFor(h.token);
  const si = await socketFor(i.token);
  const incoming = next(si, "message:new");
  const sent = await sh.emitWithAck("message:send", { conversationId: conv.id, text: "Guarda!", attachmentId: up.attachment.id });
  assert.equal(sent.message.kind, "image");
  assert.equal((await incoming).attachment.id, up.attachment.id);
  assert.ok((await sh.emitWithAck("message:send", { conversationId: conv.id, attachmentId: up.attachment.id })).error, "riuso dello stesso allegato");
  assert.ok((await si.emitWithAck("message:send", { conversationId: conv.id, attachmentId: jsonFile.attachment.id })).error, "allegato di un altro utente");

  const file = await fetch(`${base}/api/attachments/${up.attachment.id}?token=${i.token}`);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await file.arrayBuffer()), png);
  const part = await fetch(`${base}/api/attachments/${up.attachment.id}?token=${i.token}`, { headers: { range: "bytes=2-5" } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get("content-range"), `bytes 2-5/${png.length}`);
  assert.equal((await fetch(`${base}/api/attachments/${up.attachment.id}?token=${out.token}`)).status, 404);
  assert.equal((await fetch(`${base}/api/attachments/${up.attachment.id}`)).status, 401);

  const list = await call("GET", "/api/conversations", i.token);
  assert.equal(list.conversations[0].lastMessage.kind, "image");
});

test("modifica ed eliminazione dei messaggi", async () => {
  const l = await register("luca");
  const n = await register("nina");
  const { conversation: conv } = await call("POST", "/api/conversations", l.token, { userId: n.user.id });
  const sl = await socketFor(l.token);
  const sn = await socketFor(n.token);
  const { message } = await sl.emitWithAck("message:send", { conversationId: conv.id, text: "Ci vediamo alle 8" });

  assert.ok((await sn.emitWithAck("message:edit", { messageId: message.id, text: "hack" })).error);
  assert.ok((await sl.emitWithAck("message:edit", { messageId: message.id, text: "  " })).error);

  const updated = next(sn, "message:update");
  const edited = await sl.emitWithAck("message:edit", { messageId: message.id, text: "Ci vediamo alle 9" });
  assert.equal(edited.message.text, "Ci vediamo alle 9");
  assert.ok(edited.message.editedAt);
  assert.equal((await updated).text, "Ci vediamo alle 9");

  assert.ok((await sn.emitWithAck("message:delete", { messageId: message.id })).error);
  const removed = next(sn, "message:update");
  const del = await sl.emitWithAck("message:delete", { messageId: message.id });
  assert.ok(del.message.deletedAt);
  assert.equal(del.message.text, "");
  assert.ok((await removed).deletedAt);
  assert.ok((await sl.emitWithAck("message:edit", { messageId: message.id, text: "di nuovo" })).error);

  const history = await call("GET", `/api/conversations/${conv.id}/messages`, n.token);
  assert.equal(history.messages[0].text, "");
  const list = await call("GET", "/api/conversations", n.token);
  assert.equal(list.conversations[0].unread, 0, "i messaggi eliminati non contano come non letti");
});

test("notifiche push: chiave e iscrizione", async () => {
  const o = await register("olga");
  const { publicKey } = await call("GET", "/api/push/key", o.token);
  assert.match(publicKey, /^[A-Za-z0-9_-]{80,}$/);
  const sub = { endpoint: "https://push.example.org/abc", keys: { p256dh: "x", auth: "y" } };
  assert.equal((await call("POST", "/api/push/subscribe", o.token, { subscription: { endpoint: "http://insicuro" } })).status, 400);
  assert.equal((await call("POST", "/api/push/subscribe", o.token, { subscription: sub })).status, 200);
  assert.equal((await server.db.pushSubscriptionsFor([o.user.id])).length, 1);
  await call("POST", "/api/push/unsubscribe", o.token, { endpoint: sub.endpoint });
  assert.equal((await server.db.pushSubscriptionsFor([o.user.id])).length, 0);
});

test("senza JWT_SECRET la chiave viene creata una volta e conservata nel database", async () => {
  const dir = (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "vibloo-"));
  const dbFile = `${dir}/s.db`;
  const first = await createServer({ dbFile });
  const key = await first.db.getSetting("jwt_secret");
  assert.match(key, /^[0-9a-f]{64}$/);
  first.io.close(); await first.db.close();
  const second = await createServer({ dbFile });
  assert.equal(await second.db.getSetting("jwt_secret"), key);
  second.io.close(); await second.db.close();
});

test("foto profilo", async () => {
  const p = await register("paola");
  const q = await register("quirino");
  const sq = await socketFor(q.token);
  await call("POST", "/api/conversations", q.token, { userId: p.user.id });
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
  const put = (token, body, type) => fetch(`${base}/api/me/avatar`, {
    method: "PUT", headers: { authorization: `Bearer ${token}`, "content-type": type }, body,
  }).then(async (r) => ({ status: r.status, ...(await r.json()) }));

  assert.equal((await put(p.token, "ciao", "text/plain")).status, 400);
  assert.equal((await put(p.token, Buffer.alloc(3 * 1024 * 1024), "image/png")).status, 413);

  const live = next(sq, "profile");
  const saved = await put(p.token, png, "image/png");
  assert.equal(saved.status, 200);
  assert.deepEqual(await live, { userId: p.user.id, avatarAt: saved.avatarAt });

  const img = await fetch(`${base}/api/users/${p.user.id}/avatar?token=${q.token}&v=${saved.avatarAt}`);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await img.arrayBuffer()), png);
  assert.equal((await fetch(`${base}/api/users/${p.user.id}/avatar`)).status, 401);

  assert.equal((await call("GET", "/api/me", p.token)).user.avatarAt, saved.avatarAt);
  const found = await call("GET", "/api/users?q=paola", q.token);
  assert.equal(found.users[0].avatarAt, saved.avatarAt);
  const list = await call("GET", "/api/conversations", q.token);
  assert.equal(list.conversations[0].members.find((m) => m.id === p.user.id).avatarAt, saved.avatarAt);

  const removed = await fetch(`${base}/api/me/avatar`, { method: "DELETE", headers: { authorization: `Bearer ${p.token}` } });
  assert.equal(removed.status, 200);
  assert.equal((await fetch(`${base}/api/users/${p.user.id}/avatar?token=${q.token}`)).status, 404);
  assert.equal((await call("GET", "/api/me", p.token)).user.avatarAt, null);
});
