import { createServer as createHttpServer } from "node:http";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { Server } from "socket.io";
import { openDb } from "./db/index.js";
import { hashPassword, verifyPassword, makeTokens } from "./auth.js";

const USERNAME_RE = /^[a-zA-Z0-9_.]{3,24}$/;
const MAX_MESSAGE = 4000;
const MAX_GROUP = 256;
const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));

const toId = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
const userRoom = (id) => `u:${id}`;

export async function createServer({ dbFile = "cortile.db", databaseUrl, secret }) {
  if (!secret) throw new Error("JWT secret mancante");
  const db = await openDb({ dbFile, databaseUrl });
  const tokens = makeTokens(secret);

  // userId -> number of open connections
  const online = new Map();
  const isOnline = (id) => (online.get(id) ?? 0) > 0;

  // Adds live "online" flags to conversation summaries.
  const withPresence = (convs) =>
    convs.map((c) => ({ ...c, members: c.members.map((m) => ({ ...m, online: isOnline(m.id) })) }));
  const summary = async (userId, conversationId) =>
    withPresence(await db.conversationsFor(userId, conversationId))[0];

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: "32kb" }));

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
    res.json({ user: { id: user.id, username: user.username } });
  });

  app.get("/api/users", requireUser, async (req, res) => {
    const q = String(req.query.q ?? "").trim().slice(0, 24);
    const users = await db.searchUsers(q, req.user.id);
    res.json({ users: users.map((u) => ({ ...u, online: isOnline(u.id) })) });
  });

  app.get("/api/conversations", requireUser, async (req, res) => {
    res.json({ conversations: withPresence(await db.conversationsFor(req.user.id)) });
  });

  // { userId } opens (or reuses) a private chat; { name, userIds } creates a group.
  app.post("/api/conversations", requireUser, async (req, res) => {
    const me = req.user.id;
    const body = req.body ?? {};
    let id, created;

    if (body.userId !== undefined) {
      const other = toId(body.userId);
      if (!other || other === me || !(await db.findUserById(other))) {
        return res.status(400).json({ error: "Persona non trovata." });
      }
      ({ id, created } = await db.findOrCreateDirect(me, other));
    } else {
      const name = String(body.name ?? "").trim();
      const userIds = Array.isArray(body.userIds) ? [...new Set(body.userIds.map(toId).filter(Boolean))].filter((u) => u !== me) : [];
      if (!name || name.length > 40) return res.status(400).json({ error: "Dai al gruppo un nome (massimo 40 caratteri)." });
      if (!userIds.length) return res.status(400).json({ error: "Scegli almeno una persona da aggiungere al gruppo." });
      if (userIds.length >= MAX_GROUP) return res.status(400).json({ error: `Un gruppo può avere al massimo ${MAX_GROUP} persone.` });
      for (const u of userIds) {
        if (!(await db.findUserById(u))) return res.status(400).json({ error: "Una delle persone scelte non esiste più." });
      }
      id = await db.createGroup(name, me, userIds);
      created = true;
    }

    if (created) {
      for (const memberId of await db.memberIds(id)) {
        io.to(userRoom(memberId)).emit("conversation:new", await summary(memberId, id));
      }
    }
    res.status(created ? 201 : 200).json({ conversation: await summary(me, id) });
  });

  app.get("/api/conversations/:id/messages", requireUser, async (req, res) => {
    const id = toId(req.params.id);
    if (!id || !(await db.isMember(id, req.user.id))) return res.status(404).json({ error: "Chat non trovata." });
    const before = toId(req.query.before) ?? undefined;
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 100);
    res.json({ messages: await db.messages(id, before, limit) });
  });

  // The web app (built from ../app with `npm run build:web`) is served from
  // the same address, so phones only need to open this server's link.
  if (existsSync(PUBLIC_DIR)) {
    app.use(express.static(PUBLIC_DIR));
    app.get(/^\/(?!api\/|socket\.io\/).*/, (_req, res) => res.sendFile("index.html", { root: PUBLIC_DIR }));
  }

  // Unexpected errors (e.g. database unreachable) get a readable message.
  app.use((err, _req, res, _next) => {
    console.error(err);
    res.status(500).json({ error: "Errore del server. Riprova tra poco." });
  });

  const httpServer = createHttpServer(app);
  const io = new Server(httpServer, { cors: { origin: "*" } });

  const toMembers = async (conversationId, event, payload, exceptUserId) => {
    for (const id of await db.memberIds(conversationId)) {
      if (id !== exceptUserId) io.to(userRoom(id)).emit(event, payload);
    }
  };

  io.use((socket, next) => {
    const user = tokens.verify(socket.handshake.auth?.token);
    if (!user) return next(new Error("unauthorized"));
    socket.data.user = user;
    next();
  });

  io.on("connection", (socket) => {
    const user = socket.data.user;
    socket.join(userRoom(user.id));
    online.set(user.id, (online.get(user.id) ?? 0) + 1);
    if (online.get(user.id) === 1) io.emit("presence", { userId: user.id, online: true, lastSeen: null });

    const handle = (event, fn) =>
      socket.on(event, async (payload, ack) => {
        const reply = typeof ack === "function" ? ack : () => {};
        try {
          await fn(payload ?? {}, reply);
        } catch (err) {
          console.error(err);
          reply({ error: "Errore del server. Riprova." });
        }
      });

    handle("message:send", async ({ conversationId, text }, reply) => {
      const id = toId(conversationId);
      const body = typeof text === "string" ? text.trim() : "";
      if (!body) return reply({ error: "Il messaggio è vuoto." });
      if (body.length > MAX_MESSAGE) return reply({ error: `Il messaggio supera i ${MAX_MESSAGE} caratteri.` });
      if (!id || !(await db.isMember(id, user.id))) return reply({ error: "Chat non trovata." });
      const message = await db.addMessage(id, user.id, body);
      reply({ message });
      await toMembers(id, "message:new", message);
    });

    handle("delivered", async ({ conversationId, messageId }) => {
      const id = toId(conversationId), mid = toId(messageId);
      if (!id || !mid || !(await db.isMember(id, user.id))) return;
      await toMembers(id, "receipt", await db.markDelivered(id, user.id, mid));
    });

    handle("read", async ({ conversationId, messageId }) => {
      const id = toId(conversationId), mid = toId(messageId);
      if (!id || !mid || !(await db.isMember(id, user.id))) return;
      await toMembers(id, "receipt", await db.markRead(id, user.id, mid));
    });

    handle("typing", async ({ conversationId, typing }) => {
      const id = toId(conversationId);
      if (!id || !(await db.isMember(id, user.id))) return;
      await toMembers(id, "typing", { conversationId: id, user, typing: Boolean(typing) }, user.id);
    });

    socket.on("disconnect", async () => {
      const left = (online.get(user.id) ?? 1) - 1;
      if (left > 0) return online.set(user.id, left);
      online.delete(user.id);
      const lastSeen = Date.now();
      io.emit("presence", { userId: user.id, online: false, lastSeen });
      try { await db.touchLastSeen(user.id); } catch (err) { console.error(err); }
    });
  });

  return { app, httpServer, io, db };
}
