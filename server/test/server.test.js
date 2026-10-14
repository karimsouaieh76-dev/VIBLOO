import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { io as connect } from "socket.io-client";
import { createServer } from "../src/app.js";

let server, base;

before(async () => {
  server = createServer({ dbFile: ":memory:", secret: "test-secret" });
  await new Promise((r) => server.httpServer.listen(0, r));
  base = `http://127.0.0.1:${server.httpServer.address().port}`;
});

after(() => {
  server.io.close();
  server.httpServer.close();
});

const post = (path, body, token) =>
  fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
  });

const get = (path, token) => fetch(base + path, { headers: { authorization: `Bearer ${token}` } });

test("registrazione, login e validazione", async () => {
  let res = await post("/api/register", { username: "anna", password: "segreta123" });
  assert.equal(res.status, 201);
  res = await post("/api/register", { username: "ANNA", password: "segreta123" });
  assert.equal(res.status, 409);
  res = await post("/api/register", { username: "x", password: "segreta123" });
  assert.equal(res.status, 400);
  res = await post("/api/login", { username: "anna", password: "sbagliata" });
  assert.equal(res.status, 401);
  res = await post("/api/login", { username: "anna", password: "segreta123" });
  assert.equal(res.status, 200);
  const { token } = await res.json();
  res = await get("/api/me", token);
  assert.equal((await res.json()).user.username, "anna");
  res = await get("/api/me", "token-falso");
  assert.equal(res.status, 401);
});

test("canali e messaggi in tempo reale", async () => {
  const a = await (await post("/api/register", { username: "bruno", password: "password1" })).json();
  const b = await (await post("/api/register", { username: "carla", password: "password2" })).json();

  const { channels } = await (await get("/api/channels", a.token)).json();
  assert.equal(channels[0].name, "generale");

  const created = await post("/api/channels", { name: "Progetti Casa" }, a.token);
  assert.equal(created.status, 201);
  assert.equal((await created.json()).channel.name, "progetti-casa");

  const sa = connect(base, { auth: { token: a.token }, transports: ["websocket"] });
  const sb = connect(base, { auth: { token: b.token }, transports: ["websocket"] });
  await Promise.all([sa, sb].map((s) => new Promise((r) => s.on("connect", r))));

  const received = new Promise((r) => sb.on("message:new", r));
  const ack = await sa.emitWithAck("message:send", { channelId: channels[0].id, text: "  Ciao a tutti!  " });
  assert.equal(ack.message.text, "Ciao a tutti!");
  const msg = await received;
  assert.equal(msg.username, "bruno");

  const empty = await sa.emitWithAck("message:send", { channelId: channels[0].id, text: "   " });
  assert.ok(empty.error);

  const typing = new Promise((r) => sb.on("typing", r));
  sa.emit("typing", { channelId: channels[0].id, typing: true });
  assert.equal((await typing).user.username, "bruno");

  const history = await (await get(`/api/channels/${channels[0].id}/messages`, b.token)).json();
  assert.equal(history.messages.at(-1).text, "Ciao a tutti!");

  const bad = connect(base, { auth: { token: "nope" }, transports: ["websocket"], reconnection: false });
  const err = await new Promise((r) => bad.on("connect_error", r));
  assert.equal(err.message, "unauthorized");

  sa.close(); sb.close(); bad.close();
});
