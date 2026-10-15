import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { io as connect } from "socket.io-client";
import { createServer } from "../src/app.js";

let server, base;
const sockets = [];
before(async () => {
  // Invitations on, starting from an empty database.
  server = await createServer({ dbFile: ":memory:", databaseUrl: process.env.TEST_INVITES_DATABASE_URL, secret: "test-secret" });
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
const register = (username, invite) => call("POST", "/api/register", null, { username, password: "password123", invite });

test("registrazione su invito", async () => {
  // The first account needs no invitation.
  const karim = await register("karim");
  assert.equal(karim.status, 201);

  // Everyone after that does.
  assert.equal((await register("intruso")).status, 403);
  assert.equal((await register("intruso", "ABCD-EFGH")).status, 403);

  const sk = connect(base, { auth: { token: karim.token }, transports: ["websocket"] });
  sockets.push(sk);
  await new Promise((r) => sk.on("connect", r));

  const created = await call("POST", "/api/invites", karim.token, {});
  assert.equal(created.status, 201);
  const code = created.invite.code;
  assert.match(code, /^[A-HJ-NP-Z2-9]{8}$/);

  const check = await call("GET", `/api/invites/${code.toLowerCase().slice(0, 4)}-${code.slice(4)}`);
  assert.deepEqual({ valid: check.valid, inviter: check.inviter }, { valid: true, inviter: "karim" });

  const newChat = new Promise((r) => sk.once("conversation:new", r));
  const used = new Promise((r) => sk.once("invite:used", r));
  const lucia = await register("lucia", `${code.slice(0, 4)}-${code.slice(4).toLowerCase()}`);
  assert.equal(lucia.status, 201);
  assert.equal((await used).username, "lucia");

  // Lucia and Karim are contacts right away: chat accepted on both sides.
  const chat = await newChat;
  assert.equal(chat.myStatus, "accepted");
  const luciaView = (await call("GET", "/api/conversations", lucia.token)).conversations[0];
  assert.equal(luciaView.myStatus, "accepted");
  assert.deepEqual((await call("GET", "/api/contacts", lucia.token)).users.map((u) => u.username), ["karim"]);

  // Single use.
  assert.equal((await register("mario", code)).status, 403);
  assert.equal((await call("GET", `/api/invites/${code}`)).valid, false);
  const list = await call("GET", "/api/invites", karim.token);
  assert.deepEqual(list.invites.map((i) => [i.status, i.usedBy]), [["used", "lucia"]]);
  assert.equal(list.inviteOnly, true);

  // A taken username does not burn the invitation.
  const second = (await call("POST", "/api/invites", lucia.token, {})).invite.code;
  assert.equal((await register("karim", second)).status, 409);
  assert.equal((await register("mario", second)).status, 201);

  // Cancelling an unused invitation.
  const third = (await call("POST", "/api/invites", karim.token, {})).invite.code;
  assert.equal((await call("DELETE", `/api/invites/${third}`, lucia.token)).status, 404, "solo chi l'ha creato");
  assert.equal((await call("DELETE", `/api/invites/${third}`, karim.token)).ok, true);
  assert.equal((await register("nina", third)).status, 403);
});

test("gli inviti scadono e hanno un limite", async () => {
  const owner = (await call("POST", "/api/login", null, { username: "karim", password: "password123" })).token;
  const code = (await call("POST", "/api/invites", owner, {})).invite.code;
  await server.db.createInvite("ZZZZZZZZ", 1, -1000); // already expired
  assert.equal((await call("GET", "/api/invites/ZZZZZZZZ")).valid, false);
  assert.equal((await register("oreste", "ZZZZZZZZ")).status, 403);
  for (let i = 0; i < 25; i++) await call("POST", "/api/invites", owner, {});
  const res = await call("POST", "/api/invites", owner, {});
  assert.equal(res.status, 429);
  assert.ok(code);
});
