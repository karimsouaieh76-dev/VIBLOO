import { createServer as createHttpServer } from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { Server } from "socket.io";
import { openDb } from "./db/index.js";
import { hashPassword, verifyPassword, makeTokens } from "./auth.js";

const USERNAME_RE = /^[a-zA-Z0-9_.]{3,24}$/;
const CHANNEL_RE = /^[a-z0-9_-]{2,32}$/;
const MAX_MESSAGE = 2000;
const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));

export async function createServer({ dbFile = "cortile.db", databaseUrl, secret }) {
  if (!secret) throw new Error("JWT secret mancante");
  const db = await openDb({ dbFile, databaseUrl });
  const tokens = makeTokens(secret);

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "16kb" }));

  const requireUser = (req, res, next) => {
    const header = req.get("authorization") || "";
    const user = tokens.verify(header.replace(/^Bearer\s+/i, ""));
    if (!user) return res.status(401).json({ error: "Sessione scaduta: accedi di nuovo." });
    req.user = user;
    next();
  };

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  app.post("/api/register", async (req, res) => {
    const { username, password } = req.body ?? {};
    if (typeof username !== "string" || !USERNAME_RE.test(username)) {
      return res.status(400).json({ error: "Il nome utente deve avere 3-24 caratteri: lettere, numeri, punto o trattino basso." });
    }
    if (typeof password !== "string" || password.length < 8) {
      return res.status(400).json({ error: "La password deve avere almeno 8 caratteri." });
    }
    if (await db.findUserByName(username)) {
      return res.status(409).json({ error: "Questo nome utente è già in uso." });
    }
    const user = await db.createUser(username, await hashPassword(password));
    res.status(201).json({ token: tokens.sign(user), user });
  });

  app.post("/api/login", async (req, res) => {
    const { username, password } = req.body ?? {};
    const row = typeof username === "string" ? await db.findUserByName(username) : null;
    if (!row || typeof password !== "string" || !(await verifyPassword(password, row.password_hash))) {
      return res.status(401).json({ error: "Nome utente o password non corretti." });
    }
    const user = { id: row.id, username: row.username };
    res.json({ token: tokens.sign(user), user });
  });

  app.get("/api/me", requireUser, async (req, res) => {
    const user = await db.findUserById(req.user.id);
    if (!user) return res.status(401).json({ error: "Account non trovato." });
    res.json({ user });
  });

  app.get("/api/channels", requireUser, async (_req, res) => res.json({ channels: await db.listChannels() }));

  app.post("/api/channels", requireUser, async (req, res) => {
    const name = String(req.body?.name ?? "").trim().toLowerCase().replace(/\s+/g, "-");
    if (!CHANNEL_RE.test(name)) {
      return res.status(400).json({ error: "Il nome del canale deve avere 2-32 caratteri: lettere minuscole, numeri, - o _." });
    }
    if ((await db.listChannels()).some((c) => c.name === name)) {
      return res.status(409).json({ error: "Esiste già un canale con questo nome." });
    }
    const channel = await db.createChannel(name, req.user.id);
    io.emit("channel:new", channel);
    res.status(201).json({ channel });
  });

  app.get("/api/channels/:id/messages", requireUser, async (req, res) => {
    const channelId = Number(req.params.id);
    if (!Number.isInteger(channelId) || !(await db.findChannel(channelId))) return res.status(404).json({ error: "Canale non trovato." });
    const before = Number.isInteger(Number(req.query.before)) && req.query.before ? Number(req.query.before) : undefined;
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    res.json({ messages: await db.messages(channelId, before, limit) });
  });

  // The web app (built from ../app with `npm run build:web`) is served from
  // the same address, so phones only need to open this server's link.
  if (existsSync(PUBLIC_DIR)) {
    app.use(express.static(PUBLIC_DIR));
    app.get(/^\/(?!api\/|socket\.io\/).*/, (_req, res) => res.sendFile("index.html", { root: PUBLIC_DIR }));
  }

  const httpServer = createHttpServer(app);
  const io = new Server(httpServer, { cors: { origin: "*" } });

  // userId -> { user, sockets }
  const online = new Map();
  const broadcastPresence = () =>
    io.emit("presence", [...online.values()].map((o) => o.user));

  io.use((socket, next) => {
    const user = tokens.verify(socket.handshake.auth?.token);
    if (!user) return next(new Error("unauthorized"));
    socket.data.user = user;
    next();
  });

  io.on("connection", (socket) => {
    const user = socket.data.user;
    const entry = online.get(user.id) ?? { user, sockets: 0 };
    entry.sockets += 1;
    online.set(user.id, entry);
    broadcastPresence();

    socket.on("message:send", async (payload, ack = () => {}) => {
      const channelId = Number(payload?.channelId);
      const text = typeof payload?.text === "string" ? payload.text.trim() : "";
      if (!text) return ack({ error: "Il messaggio è vuoto." });
      if (text.length > MAX_MESSAGE) return ack({ error: `Il messaggio supera i ${MAX_MESSAGE} caratteri.` });
      try {
        if (!Number.isInteger(channelId) || !(await db.findChannel(channelId))) return ack({ error: "Canale non trovato." });
        const message = await db.addMessage(channelId, user.id, text);
        io.emit("message:new", message);
        ack({ message });
      } catch (err) {
        console.error(err);
        ack({ error: "Messaggio non salvato. Riprova." });
      }
    });

    socket.on("typing", (payload) => {
      const channelId = Number(payload?.channelId);
      if (!channelId) return;
      socket.broadcast.emit("typing", { channelId, user, typing: Boolean(payload?.typing) });
    });

    socket.on("disconnect", () => {
      const e = online.get(user.id);
      if (e && --e.sockets <= 0) online.delete(user.id);
      broadcastPresence();
    });
  });

  // Unexpected errors (e.g. database unreachable) get a readable message.
  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: "Errore del server. Riprova tra poco." });
  });

  return { app, httpServer, io, db };
}
