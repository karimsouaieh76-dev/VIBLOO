import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { io as connect } from "socket.io-client";
import { createServer } from "../src/app.js";

let server, base;
const sockets = [];
before(async () => {
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
    method, headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) },
    body: body && JSON.stringify(body),
  });
  return { status: res.status, ...(await res.json()) };
};
const register = (username) => call("POST", "/api/register", null, { username, password: "1234" });
const socketFor = async (token) => {
  const s = connect(base, { auth: { token }, transports: ["websocket"] });
  sockets.push(s);
  await new Promise((r) => s.on("connect", r));
  return s;
};
const friends = async (a, b) => {
  const { conversation } = await call("POST", "/api/conversations", a.token, { userId: b.user.id });
  await call("POST", `/api/conversations/${conversation.id}/accept`, b.token, {});
  return conversation.id;
};

test("gestione gruppi", async () => {
  const [g1, g2, g3, g4] = [await register("gaia"), await register("gino"), await register("gea"), await register("guido")];
  await friends(g1, g2);
  await friends(g1, g3);
  const { conversation } = await call("POST", "/api/conversations", g1.token, { name: "Calcetto", userIds: [g2.user.id] });
  const id = conversation.id;
  assert.equal(conversation.createdBy, g1.user.id);

  // Anyone in the group can rename it; a line appears in the chat.
  const renamed = await call("PUT", `/api/conversations/${id}`, g2.token, { name: "Calcetto giovedì" });
  assert.equal(renamed.conversation.name, "Calcetto giovedì");
  const lines = (await call("GET", `/api/conversations/${id}/messages`, g1.token)).messages;
  assert.equal(lines.at(-1).kind, "system");
  assert.match(lines.at(-1).text, /gino ha cambiato il nome/);
  // System lines are not unread messages.
  assert.equal((await call("GET", "/api/conversations", g1.token)).conversations.find((c) => c.id === id).unread, 0);

  // Only the admin adds and removes people.
  assert.equal((await call("POST", `/api/conversations/${id}/members`, g2.token, { userIds: [g3.user.id] })).status, 403);
  const added = await call("POST", `/api/conversations/${id}/members`, g1.token, { userIds: [g3.user.id, g4.user.id] });
  assert.equal(added.conversation.members.length, 4);
  // gea is a contact of gaia, guido is not: he gets a request.
  assert.equal(added.conversation.members.find((m) => m.id === g3.user.id).status, "accepted");
  assert.equal(added.conversation.members.find((m) => m.id === g4.user.id).status, "pending");
  assert.equal((await call("DELETE", `/api/conversations/${id}/members/${g1.user.id}`, g2.token)).status, 403);
  assert.equal((await call("DELETE", `/api/conversations/${id}/members/${g4.user.id}`, g1.token)).status, 200);
  assert.equal((await call("GET", `/api/conversations/${id}/messages`, g4.token)).status, 404);

  // The admin leaves: the longest-standing member takes over.
  assert.equal((await call("DELETE", `/api/conversations/${id}/members/${g1.user.id}`, g1.token)).status, 200);
  const after = (await call("GET", "/api/conversations", g2.token)).conversations.find((c) => c.id === id);
  assert.equal(after.createdBy, g2.user.id);
  assert.equal(after.members.length, 2);
});

test("silenzia, cerca ed elimina account", async () => {
  const a = await register("silvia");
  const b = await register("sergio");
  const id = await friends(a, b);
  const muted = await call("PUT", `/api/conversations/${id}/mute`, b.token, { until: -1 });
  assert.ok(muted.conversation.mutedUntil > Date.now());
  assert.deepEqual(await server.db.mutedIn(id), [b.user.id]);
  assert.equal((await call("PUT", `/api/conversations/${id}/mute`, b.token, { until: null })).conversation.mutedUntil, null);

  const sa = await socketFor(a.token);
  await sa.emitWithAck("message:send", { conversationId: id, text: "Ci vediamo al 100% domani" });
  await sa.emitWithAck("message:send", { conversationId: id, text: "Porta la PALLA" });
  const found = await call("GET", "/api/search?q=palla", b.token);
  assert.deepEqual(found.messages.map((m) => m.text), ["Porta la PALLA"]);
  assert.equal((await call("GET", "/api/search?q=100%25", b.token)).messages.length, 1);
  assert.equal((await call("GET", "/api/search?q=palla", (await register("terzo")).token)).messages.length, 0);

  // Deleting needs the password; the other person keeps the messages.
  assert.equal((await call("DELETE", "/api/me", a.token, { password: "sbagliata" })).status, 403);
  assert.equal((await call("DELETE", "/api/me", a.token, { password: "1234" })).status, 200);
  assert.equal((await call("GET", "/api/me", a.token)).status, 401);
  assert.equal((await call("POST", "/api/login", null, { username: "silvia", password: "1234" })).status, 401);
  const view = (await call("GET", "/api/conversations", b.token)).conversations.find((c) => c.id === id);
  const gone = view.members.find((m) => m.id === a.user.id);
  assert.equal(gone.deleted, true);
  assert.match(gone.username, /^Account eliminato/);
  assert.equal((await call("GET", `/api/conversations/${id}/messages`, b.token)).messages.length, 2);
  const sb = await socketFor(b.token);
  assert.match((await sb.emitWithAck("message:send", { conversationId: id, text: "ehi?" })).error, /eliminato/);
  // The name is free again.
  assert.equal((await register("silvia")).status, 201);
});
