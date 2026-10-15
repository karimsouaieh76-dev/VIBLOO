import { test, afterEach } from "node:test";
import assert from "node:assert/strict";

// Each scenario loads a fresh copy of the module (its TURN cache starts empty).
let n = 0;
const fresh = () => import(`../src/calls.js?case=${++n}`);
const realFetch = globalThis.fetch;
const KEYS = ["CLOUDFLARE_TURN_KEY_ID", "CLOUDFLARE_TURN_API_TOKEN", "METERED_DOMAIN", "METERED_API_KEY", "TURN_URLS", "TURN_USERNAME", "TURN_CREDENTIAL"];
afterEach(() => { globalThis.fetch = realFetch; for (const k of KEYS) delete process.env[k]; });

test("senza TURN: solo STUN", async () => {
  const { iceServers } = await fresh();
  const r = await iceServers();
  assert.equal(r.hasTurn, false);
  assert.equal(r.iceServers.length, 1);
});

test("TURN fisso da variabili", async () => {
  Object.assign(process.env, { TURN_URLS: "turn:t.example.org:3478, turns:t.example.org:443", TURN_USERNAME: "u", TURN_CREDENTIAL: "p" });
  const r = await (await fresh()).iceServers();
  assert.equal(r.hasTurn, true);
  assert.deepEqual(r.iceServers[1], { urls: ["turn:t.example.org:3478", "turns:t.example.org:443"], username: "u", credential: "p" });
});

test("Cloudflare: credenziali generate e tenute in cache", async () => {
  Object.assign(process.env, { CLOUDFLARE_TURN_KEY_ID: "kid", CLOUDFLARE_TURN_API_TOKEN: "tok" });
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    return { ok: true, json: async () => ({ iceServers: { urls: ["turn:turn.cloudflare.com:3478?transport=udp"], username: "x", credential: "y" } }) };
  };
  const { iceServers } = await fresh();
  const r = await iceServers();
  await iceServers();
  assert.equal(calls.length, 1, "seconda richiesta dalla cache");
  assert.equal(calls[0].url, "https://rtc.live.cloudflare.com/v1/turn/keys/kid/credentials/generate-ice-servers");
  assert.equal(calls[0].init.headers.authorization, "Bearer tok");
  assert.equal(r.hasTurn, true);
});

test("Metered.ca", async () => {
  Object.assign(process.env, { METERED_DOMAIN: "vibloo.metered.live", METERED_API_KEY: "abc" });
  globalThis.fetch = async (url) => {
    assert.equal(url, "https://vibloo.metered.live/api/v1/turn/credentials?apiKey=abc");
    return { ok: true, json: async () => [{ urls: "stun:stun.relay.metered.ca:80" }, { urls: "turn:global.relay.metered.ca:80", username: "a", credential: "b" }] };
  };
  const r = await (await fresh()).iceServers();
  assert.equal(r.hasTurn, true);
  assert.equal(r.iceServers.length, 3);
});

test("se il servizio TURN non risponde la chiamata prova comunque con STUN", async () => {
  Object.assign(process.env, { METERED_DOMAIN: "x.metered.live", METERED_API_KEY: "bad" });
  globalThis.fetch = async () => ({ ok: false, status: 401 });
  const r = await (await fresh()).iceServers();
  assert.equal(r.hasTurn, false);
  assert.equal(r.iceServers.length, 1);
});
