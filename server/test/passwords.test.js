import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { io as connect } from "socket.io-client";
import { createServer } from "../src/app.js";

let server, base;
const sockets = [];
before(async () => {
  server = await createServer({ dbFile: ":memory:", secret: "test-secret" });
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
const login = (username, password) => call("POST", "/api/login", null, { username, password });

test("cambio password e codice di ripristino", async () => {
  const admin = await call("POST", "/api/register", null, { username: "admin", password: "1111" });
  const { invite } = await call("POST", "/api/invites", admin.token, {});
  const anna = await call("POST", "/api/register", null, { username: "anna", password: "2222", invite: invite.code });
  const { invite: inv2 } = await call("POST", "/api/invites", anna.token, {});
  const beppe = await call("POST", "/api/register", null, { username: "beppe", password: "3333", invite: inv2.code });

  // Changing your own password needs the current one and ends other sessions.
  const other = (await login("anna", "2222")).token;
  const s = connect(base, { auth: { token: other }, transports: ["websocket"] });
  sockets.push(s);
  await new Promise((r) => s.on("connect", r));
  const dropped = new Promise((r) => s.once("disconnect", r));
  assert.equal((await call("PUT", "/api/me/password", anna.token, { current: "sbagliata", password: "4444" })).status, 403);
  const changed = await call("PUT", "/api/me/password", anna.token, { current: "2222", password: "4444" });
  assert.equal(changed.status, 200);
  await dropped;
  assert.equal((await call("GET", "/api/me", other)).status, 401, "la vecchia sessione non vale più");
  assert.equal((await call("GET", "/api/me", changed.token)).user.username, "anna");
  assert.equal((await login("anna", "2222")).status, 401);
  assert.equal((await login("anna", "4444")).status, 200);

  // Beppe forgot his: Anna invited him, so she can make a code; Beppe himself cannot.
  assert.equal((await call("POST", "/api/password-resets", beppe.token, { username: "anna" })).status, 403);
  const reset = await call("POST", "/api/password-resets", changed.token, { username: "Beppe" });
  assert.equal(reset.status, 201);
  assert.equal((await call("POST", "/api/password/reset", null, { username: "beppe", code: "AAAAAAAA", password: "5555" })).status, 400);
  const back = await call("POST", "/api/password/reset", null, { username: "beppe", code: reset.code, password: "5555" });
  assert.equal(back.status, 200);
  assert.equal((await call("GET", "/api/me", back.token)).user.username, "beppe");
  assert.equal((await call("GET", "/api/me", beppe.token)).status, 401);
  assert.equal((await call("POST", "/api/password/reset", null, { username: "beppe", code: reset.code, password: "6666" })).status, 400, "il codice vale una volta sola");

  // The admin can help anyone.
  assert.equal((await call("POST", "/api/password-resets", admin.token, { username: "beppe" })).status, 201);
});
