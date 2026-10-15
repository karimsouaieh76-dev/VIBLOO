import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import https from "node:https";
import { execFileSync } from "node:child_process";
import { createECDH, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { io as connect } from "socket.io-client";
import { createServer } from "../src/app.js";

// A fake browser push service on https://localhost records what the server sends.
let server, base, pushService, pushPort;
const received = [];
let nextStatus = 201;
const sockets = [];

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), "vibloo-push-"));
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
    "-addext", "subjectAltName=DNS:localhost", "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem")], { stdio: "ignore" });
  const cert = readFileSync(join(dir, "cert.pem"));
  https.globalAgent.options.ca = cert;
  pushService = https.createServer({ key: readFileSync(join(dir, "key.pem")), cert }, (req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      received.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(nextStatus).end();
    });
  });
  await new Promise((r) => pushService.listen(0, r));
  pushPort = pushService.address().port;

  server = await createServer({ dbFile: ":memory:", secret: "test-secret", inviteOnly: false });
  await new Promise((r) => server.httpServer.listen(0, r));
  base = `http://127.0.0.1:${server.httpServer.address().port}`;
});

after(async () => {
  sockets.forEach((s) => s.close());
  server.io.close();
  server.httpServer.close();
  pushService.closeAllConnections();
  pushService.close();
  https.globalAgent.destroy();
  await server.db.close();
});

const post = async (path, token, body) =>
  (await fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token && { authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
  })).json();
const socketFor = async (token) => {
  const s = connect(base, { auth: { token }, transports: ["websocket"] });
  sockets.push(s);
  await new Promise((r) => s.on("connect", r));
  return s;
};
const waitFor = async (cond, ms = 3000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (cond()) return true; await new Promise((r) => setTimeout(r, 30)); }
  return false;
};
const b64url = (buf) => buf.toString("base64url");

test("prova notifiche", async () => {
  const u = await post("/api/register", null, { username: "zia", password: "password123" });
  assert.equal((await post("/api/push/test", u.token, {})).devices, 0);
});

test("notifica push a chi non ha l'app aperta", async () => {
  const anna = await post("/api/register", null, { username: "anna", password: "password123" });
  const beppe = await post("/api/register", null, { username: "beppe", password: "password123" });
  const { conversation } = await post("/api/conversations", anna.token, { userId: beppe.user.id });
  await post(`/api/conversations/${conversation.id}/accept`, beppe.token, {});

  // What a browser's PushManager would hand over.
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const endpoint = `https://localhost:${pushPort}/push/beppe`;
  await server.db.savePushSubscription(beppe.user.id, {
    endpoint, keys: { p256dh: b64url(ecdh.getPublicKey()), auth: b64url(randomBytes(16)) },
  });

  const sa = await socketFor(anna.token);
  await sa.emitWithAck("message:send", { conversationId: conversation.id, text: "Sei a casa?" });
  assert.ok(await waitFor(() => received.length === 1), "beppe è offline: riceve la notifica");
  const push = received[0];
  assert.equal(push.url, "/push/beppe");
  assert.equal(push.headers["content-encoding"], "aes128gcm");
  assert.match(push.headers.authorization, /^vapid t=.+, k=.+/);
  assert.equal(push.headers.urgency, "high");
  assert.ok(push.body.length > 0, "il contenuto è cifrato");

  // Beppe opens the app: no push while it is on screen.
  const sb = await socketFor(beppe.token);
  sb.emit("visibility", { visible: true });
  await new Promise((r) => setTimeout(r, 100));
  await sa.emitWithAck("message:send", { conversationId: conversation.id, text: "Ok ti vedo online" });
  assert.equal(await waitFor(() => received.length > 1, 600), false, "nessuna notifica con l'app aperta");

  // A call always rings the phone, even if it still looks "on screen",
  // and the notification expires with the ringing.
  const ringing = await sa.emitWithAck("call:invite", { conversationId: conversation.id, media: "audio" });
  assert.ok(await waitFor(() => received.length === 2), "notifica di chiamata anche con l'app aperta");
  assert.equal(received[1].headers.ttl, "45");
  await sa.emitWithAck("call:hangup", { callId: ringing.callId });
  received.splice(1, 1);

  // App in background again: notifications resume.
  sb.emit("visibility", { visible: false });
  await new Promise((r) => setTimeout(r, 100));
  await sa.emitWithAck("message:send", { conversationId: conversation.id, text: "Ci sei?" });
  assert.ok(await waitFor(() => received.length === 2));

  // The push service says the subscription is gone: the server forgets it.
  nextStatus = 410;
  await sa.emitWithAck("message:send", { conversationId: conversation.id, text: "Ultimo" });
  assert.ok(await waitFor(() => received.length === 3));
  let left = 1;
  for (let i = 0; i < 50 && left; i++) {
    await new Promise((r) => setTimeout(r, 30));
    left = (await server.db.pushSubscriptionsFor([beppe.user.id])).length;
  }
  assert.equal(left, 0);
});
