import { createServer as createHttpServer } from "node:http";
import express from "express";
import cors from "cors";
import { Server } from "socket.io";
import { openDb } from "./db.js";
import { hashPassword, verifyPassword, makeTokens } from "./auth.js";

const USERNAME_RE = /^[a-zA-Z0-9_.]{3,24}$/;
const CHANNEL_RE = /^[a-z0-9_-]{2,32}$/;
const MAX_MESSAGE = 2000;

export function createServer({ dbFile = "cortile.db", secret }) {
  if (!secret) throw new Error("JWT secret mancante");
  const db = openDb(dbFile);
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
    if (db.findUserByName(username)) {
      return res.status(409).json({ error: "Questo nome utente è già in uso." });
    }
    const user = db.createUser(username, await hashPassword(password));
    res.status(201).json({ token: tokens.sign(user), user });
  });

  app.post("/api/login", async (req, res) => {
    const { username, password } = req.body ?? {};
    const row = typeof username === "string" ? db.findUserByName(username) : null;
    if (!row || typeof password !== "string" || !(await verifyPassword(password, row.password_hash))) {
      return res.status(401).json({ error: "Nome utente o password non corretti." });
    }
    const user = { id: row.id, username: row.username };
    res.json({ token: tokens.sign(user), user });
  });

  app.get("/api/me", requireUser, (req, res) => {
    const user = db.findUserById(req.user.id);
    if (!user) return res.status(401).json({ error: "Account non trovato." });
    res.json({ user });
  });

  app.get("/api/channels", requireUser, (_req, res) => res.json({ channels: db.listChannels() }));

  app.post("/api/channels", requireUser, (req, res) => {
    const name = String(req.body?.name ?? "").trim().toLowerCase().replace(/\s+/g, "-");
    if (!CHANNEL_RE.test(name)) {
      return res.status(400).json({ error: "Il nome del canale deve avere 2-32 caratteri: lettere minuscole, numeri, - o _." });
    }
    if (db.listChannels().some((c) => c.name === name)) {
      return res.status(409).json({ error: "Esiste già un canale con questo nome." });
    }
    const channel = db.createChannel(name, req.user.id);
    io.emit("channel:new", channel);
    res.status(201).json({ channel });
  });

  app.get("/api/channels/:id/messages", requireUser, (req, res) => {
    const channelId = Number(req.params.id);
    if (!db.findChannel(channelId)) return res.status(404).json({ error: "Canale non trovato." });
    const before = req.query.before ? Number(req.query.before) : undefined;
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    res.json({ messages: db.messages(channelId, before, limit) });
  });

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

    socket.on("message:send", (payload, ack = () => {}) => {
      const channelId = Number(payload?.channelId);
      const text = typeof payload?.text === "string" ? payload.text.trim() : "";
      if (!text) return ack({ error: "Il messaggio è vuoto." });
      if (text.length > MAX_MESSAGE) return ack({ error: `Il messaggio supera i ${MAX_MESSAGE} caratteri.` });
      if (!db.findChannel(channelId)) return ack({ error: "Canale non trovato." });
      const message = db.addMessage(channelId, user.id, text);
      io.emit("message:new", message);
      ack({ message });
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

  return { app, httpServer, io, db };
}
