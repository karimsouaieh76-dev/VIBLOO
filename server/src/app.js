import { createServer as createHttpServer } from "node:http";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import { Server } from "socket.io";
import { openDb } from "./db/index.js";
import { hashPassword, verifyPassword, makeTokens } from "./auth.js";
import { createPush, notificationText } from "./push.js";
import { createCalls, iceServers } from "./calls.js";

const USERNAME_RE = /^[a-zA-Z0-9_.]{3,24}$/;
const MAX_MESSAGE = 4000;
const INVITE_TTL = 7 * 24 * 60 * 60 * 1000;
const MAX_OPEN_INVITES = 20;
const RESET_TTL = 24 * 60 * 60 * 1000;
// Easy to read aloud or copy: no 0/O or 1/I/L.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const newInviteCode = () => Array.from(randomBytes(8), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
const normalizeCode = (v) => {
  const c = String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return c.length === 8 ? c : null;
};
const MAX_UPLOAD = 15 * 1024 * 1024;
const EDIT_WINDOW = 24 * 60 * 60 * 1000;
const MAX_GROUP = 256;
const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));

const toId = (v) => (Number.isInteger(Number(v)) && Number(v) > 0 ? Number(v) : null);
const userRoom = (id) => `u:${id}`;

// inviteOnly: new accounts need an invitation code (except the very first one).
export async function createServer({ dbFile = "vibloo.db", databaseUrl, secret, inviteOnly = true }) {
  const db = await openDb({ dbFile, databaseUrl });
  // Without a configured secret, generate one once and keep it in the
  // database, so logins survive restarts on hosts without a persistent disk.
  if (!secret) {
    secret = await db.getSetting("jwt_secret");
    if (!secret) {
      secret = randomBytes(32).toString("hex");
      await db.setSetting("jwt_secret", secret);
    }
  }
  const tokens = makeTokens(secret);
  const push = await createPush(db);

  // userId -> number of open connections
  const online = new Map();
  const isOnline = (id) => (online.get(id) ?? 0) > 0;
  // userId -> (socketId -> last "I'm on screen" ping). A phone that closes the
  // app often cannot say so, so a ping counts only for 30 seconds.
  const visible = new Map();
  const LOOKING_FOR = 30 * 1000;
  const isLooking = (id) => {
    const now = Date.now();
    for (const at of visible.get(id)?.values() ?? []) if (now - at < LOOKING_FOR) return true;
    return false;
  };

  // What a viewer may see of the people in their chats: online status, last
  // seen and read receipts only from people who accepted the chat and have not
  // blocked them; no photo from people who blocked them.
  const withPresence = async (convs, viewerId) => {
    const blockers = new Set(await db.blockersOf(viewerId));
    const blocked = new Set(await db.blockedBy(viewerId));
    return convs.map((c) => {
      const partner = c.isGroup ? null : c.members.find((m) => m.id !== viewerId);
      return {
        ...c,
        blockedByMe: Boolean(partner && blocked.has(partner.id)),
        members: c.members.map((m) => {
          if (m.id === viewerId) return { ...m, online: isOnline(m.id) };
          const hidden = blockers.has(m.id) || m.status !== "accepted" || blocked.has(m.id);
          return {
            ...m,
            online: hidden ? false : isOnline(m.id),
            lastSeen: hidden ? null : m.lastSeen,
            avatarAt: blockers.has(m.id) ? null : m.avatarAt,
            lastReadId: m.status === "accepted" ? m.lastReadId : 0,
            lastDeliveredId: m.status === "accepted" ? m.lastDeliveredId : 0,
          };
        }),
      };
    });
  };
  const summary = async (userId, conversationId) =>
    (await withPresence(await db.conversationsFor(userId, conversationId), userId))[0];
  const roomsOf = (ids) => ids.map(userRoom);

  // Tell each member how a conversation looks to them now.
  const pushSummaries = async (conversationId, event = "conversation:update") => {
    for (const memberId of await db.memberIds(conversationId)) {
      const view = await summary(memberId, conversationId);
      if (view) io.to(userRoom(memberId)).emit(event, view);
    }
  };

  // A new photo shows up live for people in a chat with the user, minus anyone they blocked.
  const announceProfile = async (userId, avatarAt) => {
    const blocked = new Set(await db.blockedBy(userId));
    const to = (await db.coMembers(userId)).filter((id) => !blocked.has(id));
    if (to.length) io.to(roomsOf(to)).emit("profile", { userId, avatarAt });
  };

  // Presence goes only to people the user shares an accepted chat with, minus anyone they blocked.
  const announcePresence = async (userId, payload) => {
    const blocked = new Set(await db.blockedBy(userId));
    const to = (await db.audience(userId)).filter((id) => !blocked.has(id));
    if (to.length) io.to(roomsOf(to)).emit("presence", payload);
  };

  const app = express();
  app.use(cors());
  // JSON bodies everywhere except file uploads, which arrive as raw bytes.
  const json = express.json({ limit: "32kb" });
  app.use((req, res, next) => (req.path.endsWith("/attachments") || req.path === "/api/me/avatar" ? next() : json(req, res, next)));

  // Token from the Authorization header, or from ?token= for <img>/<audio> sources.
  // A session ends when its password changes (token_version moves on) or the account is gone.
  const versions = new Map(); // userId -> current token version
  const sessionValid = async (user) => {
    if (!user) return false;
    if (!versions.has(user.id)) versions.set(user.id, await db.tokenVersion(user.id));
    return versions.get(user.id) === user.v;
  };
  const requireUser = (req, res, next) => {
    const header = req.get("authorization") || "";
    const user = tokens.verify(header.replace(/^Bearer\s+/i, "") || String(req.query.token ?? ""));
    sessionValid(user).then((ok) => {
      if (!ok) return res.status(401).json({ error: "Sessione scaduta: accedi di nuovo." });
      req.user = user;
      next();
    }, next);
  };
  // New password: remember the version and close the other devices' connections.
  async function changePassword(userId, password) {
    const v = await db.setPassword(userId, await hashPassword(password));
    versions.set(userId, v);
    for (const s of await io.in(userRoom(userId)).fetchSockets()) if (s.data.user.v !== v) s.disconnect(true);
    return v;
  }

  app.get("/api/health", (_req, res) => res.json({ ok: true }));

  app.post("/api/register", async (req, res) => {
    const { username, password, invite } = req.body ?? {};
    if (typeof username !== "string" || !USERNAME_RE.test(username)) {
      return res.status(400).json({ error: "Il nome utente deve avere 3-24 caratteri: lettere, numeri, punto o trattino basso." });
    }
    if (typeof password !== "string" || password.length < 4) {
      return res.status(400).json({ error: "La password deve avere almeno 4 caratteri." });
    }
    if (await db.findUserByName(username)) {
      return res.status(409).json({ error: "Questo nome utente è già in uso." });
    }

    // The very first account needs no invitation, or nobody could ever join.
    const code = normalizeCode(invite);
    let inviterId = null;
    if (inviteOnly && (await db.countUsers()) > 0) {
      if (!code) return res.status(403).json({ error: "Per iscriverti serve un invito: chiedi il link a chi usa già Vibloo." });
      inviterId = await db.claimInvite(code);
      if (!inviterId) return res.status(403).json({ error: "Questo invito non è valido, è già stato usato o è scaduto. Chiedine uno nuovo." });
    }

    let user;
    try {
      user = await db.createUser(username, await hashPassword(password));
    } catch (err) {
      if (code && inviterId) await db.releaseInvite(code);
      if (await db.findUserByName(username)) return res.status(409).json({ error: "Questo nome utente è già in uso." });
      throw err;
    }

    // Whoever invited you is a contact straight away: a private chat both have accepted.
    if (inviterId) {
      await db.completeInvite(code, user.id);
      const { id: convId } = await db.findOrCreateDirect(inviterId, user.id);
      await db.setMemberStatus(convId, user.id, "accepted");
      await db.setMemberStatus(convId, inviterId, "accepted");
      io.to(userRoom(inviterId)).emit("conversation:new", await summary(inviterId, convId));
      io.to(userRoom(inviterId)).emit("invite:used", { code, username: user.username });
    }
    res.status(201).json({ token: tokens.sign(user), user });
  });

  // ---------- invitations ----------
  // Public: the sign-up screen shows who invited you before you choose a name.
  app.get("/api/invites/:code", async (req, res) => {
    const inv = await db.getInvite(normalizeCode(req.params.code) ?? "");
    const valid = Boolean(inv && !inv.claimedAt && inv.expiresAt > Date.now());
    res.json({ valid, inviter: valid ? inv.inviter : null });
  });

  app.get("/api/invites", requireUser, async (req, res) => {
    const now = Date.now();
    const invites = (await db.listInvites(req.user.id)).map((i) => ({
      code: i.code, createdAt: i.createdAt, expiresAt: i.expiresAt,
      status: i.usedBy ? "used" : i.expiresAt <= now ? "expired" : "open",
      usedBy: i.usedByName ?? null,
    }));
    res.json({ invites, inviteOnly });
  });

  app.post("/api/invites", requireUser, async (req, res) => {
    if ((await db.countOpenInvites(req.user.id)) >= MAX_OPEN_INVITES) {
      return res.status(429).json({ error: `Hai già ${MAX_OPEN_INVITES} inviti non usati: annullane qualcuno o aspetta che vengano usati.` });
    }
    let invite;
    for (let i = 0; i < 5 && !invite; i++) {
      try { invite = await db.createInvite(newInviteCode(), req.user.id, INVITE_TTL); } catch { /* code taken: try another */ }
    }
    if (!invite) throw new Error("Impossibile creare un codice d'invito");
    res.status(201).json({ invite: { ...invite, status: "open", usedBy: null } });
  });

  app.delete("/api/invites/:code", requireUser, async (req, res) => {
    const ok = await db.deleteInvite(normalizeCode(req.params.code) ?? "", req.user.id);
    if (!ok) return res.status(404).json({ error: "Invito non trovato o già usato." });
    res.json({ ok: true });
  });

  // Short passwords are allowed, so guessing is slowed down instead:
  // after 10 wrong attempts on a name, that name waits 15 minutes.
  const failedLogins = new Map(); // lowercased username -> { count, until }
  app.post("/api/login", async (req, res) => {
    const { username, password } = req.body ?? {};
    const key = typeof username === "string" ? username.toLowerCase() : "";
    const fails = failedLogins.get(key);
    if (fails && fails.until > Date.now() && fails.count >= 10) {
      return res.status(429).json({ error: "Troppi tentativi sbagliati. Riprova tra qualche minuto." });
    }
    const row = typeof username === "string" ? await db.findUserByName(username) : null;
    if (!row || typeof password !== "string" || !(await verifyPassword(password, row.password_hash))) {
      const now = Date.now();
      const f = fails && fails.until > now ? fails : { count: 0, until: now + 15 * 60 * 1000 };
      f.count += 1;
      failedLogins.set(key, f);
      if (failedLogins.size > 10000) for (const [k, v] of failedLogins) if (v.until <= now) failedLogins.delete(k);
      return res.status(401).json({ error: "Nome utente o password non corretti." });
    }
    failedLogins.delete(key);
    const user = { id: row.id, username: row.username };
    res.json({ token: tokens.sign(user, row.token_version ?? 0), user: { ...user, avatarAt: row.avatar_at ?? null } });
  });

  app.put("/api/me/password", requireUser, async (req, res) => {
    const { current, password } = req.body ?? {};
    const row = await db.findUserByName(req.user.username);
    if (!row || typeof current !== "string" || !(await verifyPassword(current, row.password_hash))) {
      return res.status(403).json({ error: "La password attuale non è corretta." });
    }
    if (typeof password !== "string" || password.length < 4) {
      return res.status(400).json({ error: "La nuova password deve avere almeno 4 caratteri." });
    }
    const v = await changePassword(row.id, password);
    res.json({ token: tokens.sign({ id: row.id, username: row.username }, v) });
  });

  // A forgotten password: the admin (first account) or whoever invited the
  // person makes a one-time code, and passes it on in person or by phone.
  app.post("/api/password-resets", requireUser, async (req, res) => {
    const target = typeof req.body?.username === "string" ? await db.findUserByName(req.body.username.trim()) : null;
    if (!target) return res.status(404).json({ error: "Nessun utente con questo nome." });
    if (target.id === req.user.id) return res.status(400).json({ error: "Per la tua password usa «Cambia password»." });
    const allowed = req.user.id === (await db.adminId()) || req.user.id === (await db.inviterOf(target.id));
    if (!allowed) {
      return res.status(403).json({ error: `Solo chi ha invitato ${target.username} o l'amministratore può creare il codice.` });
    }
    const code = newInviteCode();
    await db.createPasswordReset(code, target.id, req.user.id, RESET_TTL);
    res.status(201).json({ code, username: target.username, expiresAt: Date.now() + RESET_TTL });
  });

  app.post("/api/password/reset", async (req, res) => {
    const { username, code, password } = req.body ?? {};
    const key = `reset:${String(username ?? "").toLowerCase()}`;
    const fails = failedLogins.get(key);
    if (fails && fails.until > Date.now() && fails.count >= 10) {
      return res.status(429).json({ error: "Troppi tentativi sbagliati. Riprova tra qualche minuto." });
    }
    if (typeof password !== "string" || password.length < 4) {
      return res.status(400).json({ error: "La nuova password deve avere almeno 4 caratteri." });
    }
    const row = typeof username === "string" ? await db.findUserByName(username.trim()) : null;
    const c = normalizeCode(code);
    if (!row || !c || !(await db.usePasswordReset(c, row.id))) {
      const now = Date.now();
      const f = fails && fails.until > now ? fails : { count: 0, until: now + 15 * 60 * 1000 };
      f.count += 1;
      failedLogins.set(key, f);
      return res.status(400).json({ error: "Codice non valido, già usato o scaduto. Chiedine uno nuovo." });
    }
    failedLogins.delete(key);
    failedLogins.delete(row.username.toLowerCase());
    const v = await changePassword(row.id, password);
    const user = { id: row.id, username: row.username };
    res.json({ token: tokens.sign(user, v), user: { ...user, avatarAt: row.avatar_at ?? null } });
  });

  app.get("/api/me", requireUser, async (req, res) => {
    const user = await db.findUserById(req.user.id);
    if (!user) return res.status(401).json({ error: "Account non trovato." });
    res.json({ user: { id: user.id, username: user.username, avatarAt: user.avatarAt ?? null } });
  });

  // Profile photo: a JPEG/PNG/WebP up to 2 MB (the app sends a 512 px square).
  app.put("/api/me/avatar", requireUser, express.raw({ type: () => true, limit: 2 * 1024 * 1024 }), async (req, res) => {
    const mime = String(req.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!["image/jpeg", "image/png", "image/webp"].includes(mime)) {
      return res.status(400).json({ error: "La foto profilo deve essere un'immagine JPEG, PNG o WebP." });
    }
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "L'immagine è vuota." });
    const avatarAt = await db.setAvatar(req.user.id, mime, req.body);
    await announceProfile(req.user.id, avatarAt);
    res.json({ avatarAt });
  });

  app.delete("/api/me/avatar", requireUser, async (req, res) => {
    await db.removeAvatar(req.user.id);
    await announceProfile(req.user.id, null);
    res.json({ avatarAt: null });
  });

  app.get("/api/users/:id/avatar", requireUser, async (req, res) => {
    const owner = toId(req.params.id) ?? 0;
    if ((await db.blockedBy(owner)).includes(req.user.id)) return res.status(404).json({ error: "Nessuna foto profilo." });
    const photo = await db.getAvatar(owner);
    if (!photo) return res.status(404).json({ error: "Nessuna foto profilo." });
    res.set({ "Content-Type": photo.mime, "Cache-Control": "private, max-age=31536000, immutable", "X-Content-Type-Options": "nosniff" });
    res.send(photo.data);
  });

  // Exact username only; strangers never see online status or last seen.
  app.get("/api/users", requireUser, async (req, res) => {
    const q = String(req.query.q ?? "").trim().replace(/^@/, "").slice(0, 24);
    if (!q) return res.json({ users: [] });
    const blockers = new Set(await db.blockersOf(req.user.id));
    const users = await db.findByExactName(q, req.user.id);
    res.json({ users: users.map((u) => ({ ...u, online: false, lastSeen: null, avatarAt: blockers.has(u.id) ? null : u.avatarAt })) });
  });

  // People with an accepted private chat: the starting list for new chats and groups.
  app.get("/api/contacts", requireUser, async (req, res) => {
    const hidden = new Set([...(await db.blockersOf(req.user.id)), ...(await db.blockedBy(req.user.id))]);
    const users = (await db.contacts(req.user.id)).filter((u) => !hidden.has(u.id));
    res.json({ users: users.map((u) => ({ ...u, online: isOnline(u.id) })) });
  });

  app.get("/api/conversations", requireUser, async (req, res) => {
    res.json({ conversations: await withPresence(await db.conversationsFor(req.user.id), req.user.id) });
  });

  // Message requests: accept, or delete (the sender is not told).
  app.post("/api/conversations/:id/accept", requireUser, async (req, res) => {
    const id = toId(req.params.id);
    const status = id && (await db.memberStatus(id, req.user.id));
    if (!status) return res.status(404).json({ error: "Chat non trovata." });
    await db.setMemberStatus(id, req.user.id, "accepted");
    await pushSummaries(id);
    res.json({ conversation: await summary(req.user.id, id) });
  });

  app.post("/api/conversations/:id/decline", requireUser, async (req, res) => {
    const id = toId(req.params.id);
    if (!id || !(await db.memberStatus(id, req.user.id))) return res.status(404).json({ error: "Chat non trovata." });
    await db.setMemberStatus(id, req.user.id, "declined");
    io.to(userRoom(req.user.id)).emit("conversation:removed", { id });
    res.json({ ok: true });
  });

  // ---------- blocking ----------
  app.get("/api/blocks", requireUser, async (req, res) => {
    const users = [];
    for (const id of await db.blockedBy(req.user.id)) {
      const u = await db.findUserById(id);
      if (u) users.push({ id: u.id, username: u.username });
    }
    res.json({ users });
  });

  const afterBlockChange = async (me, other) => {
    // The other person immediately stops (or starts again) seeing me online and my photo.
    const blocked = (await db.blockedBy(me)).includes(other);
    const meRow = await db.findUserById(me);
    io.to(userRoom(other)).emit("presence", { userId: me, online: blocked ? false : isOnline(me), lastSeen: blocked ? null : meRow?.lastSeen ?? null });
    io.to(userRoom(other)).emit("profile", { userId: me, avatarAt: blocked ? null : meRow?.avatarAt ?? null });
    const { id: convId } = await db.findDirect(me, other);
    if (convId) {
      for (const who of [me, other]) {
        const view = await summary(who, convId);
        if (view) io.to(userRoom(who)).emit("conversation:update", view);
      }
    }
  };

  app.post("/api/blocks", requireUser, async (req, res) => {
    const other = toId(req.body?.userId);
    if (!other || other === req.user.id || !(await db.findUserById(other))) return res.status(400).json({ error: "Persona non trovata." });
    await db.block(req.user.id, other);
    // A pending request from someone you block goes away.
    const { id: convId } = await db.findDirect(req.user.id, other);
    if (convId && (await db.memberStatus(convId, req.user.id)) === "pending") {
      await db.setMemberStatus(convId, req.user.id, "declined");
      io.to(userRoom(req.user.id)).emit("conversation:removed", { id: convId });
    }
    await afterBlockChange(req.user.id, other);
    res.json({ ok: true });
  });

  app.delete("/api/blocks/:userId", requireUser, async (req, res) => {
    const other = toId(req.params.userId);
    if (!other) return res.status(400).json({ error: "Persona non trovata." });
    await db.unblock(req.user.id, other);
    await afterBlockChange(req.user.id, other);
    res.json({ ok: true });
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
      if ((await db.blockedBy(me)).includes(other)) {
        return res.status(403).json({ error: "Hai bloccato questa persona: sbloccala per scriverle." });
      }
      if ((await db.blockedBy(other)).includes(me)) return res.status(403).json({ error: "Non puoi scrivere a questa persona." });
      ({ id, created } = await db.findOrCreateDirect(me, other));
      // Writing to someone whose request you had not answered accepts it.
      if (!created && (await db.memberStatus(id, me)) !== "accepted") {
        await db.setMemberStatus(id, me, "accepted");
        await pushSummaries(id);
      }
    } else {
      const name = String(body.name ?? "").trim();
      const userIds = Array.isArray(body.userIds) ? [...new Set(body.userIds.map(toId).filter(Boolean))].filter((u) => u !== me) : [];
      if (!name || name.length > 40) return res.status(400).json({ error: "Dai al gruppo un nome (massimo 40 caratteri)." });
      if (!userIds.length) return res.status(400).json({ error: "Scegli almeno una persona da aggiungere al gruppo." });
      if (userIds.length >= MAX_GROUP) return res.status(400).json({ error: `Un gruppo può avere al massimo ${MAX_GROUP} persone.` });
      const blockers = new Set(await db.blockersOf(me));
      for (const u of userIds) {
        if (!(await db.findUserById(u))) return res.status(400).json({ error: "Una delle persone scelte non esiste più." });
        if (blockers.has(u)) return res.status(403).json({ error: "Una delle persone scelte non può essere aggiunta al gruppo." });
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

  // Upload the raw file body first, then send a message that points to it.
  app.post("/api/conversations/:id/attachments",
    requireUser,
    express.raw({ type: () => true, limit: MAX_UPLOAD }),
    async (req, res) => {
      const id = toId(req.params.id);
      if (!id || !(await db.isMember(id, req.user.id))) return res.status(404).json({ error: "Chat non trovata." });
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: "Il file è vuoto." });
      const mime = String(req.get("content-type") || "application/octet-stream").split(";")[0].trim().toLowerCase();
      let name = "file";
      try { name = decodeURIComponent(req.get("x-file-name") || "file"); } catch { /* keep default */ }
      const num = (h) => (Number.isFinite(Number(req.get(h))) && req.get(h) ? Math.round(Number(req.get(h))) : null);
      const attachment = await db.createAttachment({
        conversationId: id, userId: req.user.id, mime, name: name.slice(0, 200), data: req.body,
        width: num("x-width"), height: num("x-height"), duration: num("x-duration"),
      });
      res.status(201).json({ attachment });
    });

  // Serves a file to members of its chat. Supports Range requests, which
  // Safari needs to play audio.
  app.get("/api/attachments/:id", requireUser, async (req, res) => {
    const id = toId(req.params.id);
    const file = id && (await db.attachmentData(id));
    if (!file || !(await db.isMember(file.conversationId, req.user.id))) return res.status(404).json({ error: "File non trovato." });
    const inline = /^(image|audio|video)\//.test(file.mime) && !req.query.download;
    res.set({
      "Content-Type": file.mime,
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(file.name)}`,
      "Cache-Control": "private, max-age=31536000, immutable",
      "Accept-Ranges": "bytes",
      "X-Content-Type-Options": "nosniff",
    });
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.get("range") || "");
    if (range) {
      const size = file.data.length;
      let start = range[1] ? Number(range[1]) : size - Number(range[2]);
      let end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      start = Math.max(0, start);
      if (start > end || start >= size) return res.status(416).set("Content-Range", `bytes */${size}`).end();
      return res.status(206).set("Content-Range", `bytes ${start}-${end}/${size}`).send(file.data.subarray(start, end + 1));
    }
    res.send(file.data);
  });

  app.get("/api/call-config", requireUser, async (_req, res) => res.json(await iceServers()));

  app.get("/api/push/key", requireUser, (_req, res) => res.json({ publicKey: push.publicKey }));
  app.post("/api/push/subscribe", requireUser, async (req, res) => {
    const sub = req.body?.subscription;
    if (typeof sub?.endpoint !== "string" || !/^https:\/\//.test(sub.endpoint) || !sub.keys?.p256dh || !sub.keys?.auth) {
      return res.status(400).json({ error: "Iscrizione alle notifiche non valida." });
    }
    await db.savePushSubscription(req.user.id, sub);
    res.json({ ok: true });
  });
  // "Prova notifiche": sends a notification to the user's own devices.
  app.post("/api/push/test", requireUser, async (req, res) => {
    const sent = await push.send([req.user.id], {
      title: "Vibloo", body: "Le notifiche funzionano ✓", tag: "test",
    });
    res.json({ devices: sent });
  });
  app.post("/api/push/unsubscribe", requireUser, async (req, res) => {
    if (typeof req.body?.endpoint === "string") await db.deletePushSubscription(req.body.endpoint);
    res.json({ ok: true });
  });

  // The web app (built from ../app with `npm run build:web`) is served from
  // the same address, so phones only need to open this server's link.
  if (existsSync(PUBLIC_DIR)) {
    app.use(express.static(PUBLIC_DIR));
    app.get(/^\/(?!api\/|socket\.io\/).*/, (_req, res) => res.sendFile("index.html", { root: PUBLIC_DIR }));
  }

  // Unexpected errors (e.g. database unreachable) get a readable message.
  app.use((err, _req, res, _next) => {
    if (err?.type === "entity.too.large") {
      return res.status(413).json({ error: "Il file è troppo grande." });
    }
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

  // Push to members who are not looking at the app right now.
  const notify = (conversationId, message, userIds) => {
    if (!userIds.length) return;
    (async () => {
      const meta = await db.conversationMeta(conversationId);
      await push.send(userIds, { ...notificationText(message, meta), conversationId, tag: `c${conversationId}` });
    })().catch((err) => console.error(err));
  };

  const calls = createCalls({ io, db, push, isLooking, userRoom });

  io.use((socket, next) => {
    const user = tokens.verify(socket.handshake.auth?.token);
    sessionValid(user).then((ok) => {
      if (!ok) return next(new Error("unauthorized"));
      socket.data.user = user;
      next();
    }, () => next(new Error("unavailable")));
  });

  io.on("connection", (socket) => {
    const user = socket.data.user;
    socket.join(userRoom(user.id));
    online.set(user.id, (online.get(user.id) ?? 0) + 1);
    if (online.get(user.id) === 1) announcePresence(user.id, { userId: user.id, online: true, lastSeen: null }).catch((e) => console.error(e));

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

    handle("message:send", async ({ conversationId, text, attachmentId, replyToId }, reply) => {
      const id = toId(conversationId);
      const body = typeof text === "string" ? text.trim() : "";
      if (body.length > MAX_MESSAGE) return reply({ error: `Il messaggio supera i ${MAX_MESSAGE} caratteri.` });
      if (!id || !(await db.isMember(id, user.id))) return reply({ error: "Chat non trovata." });
      if ((await db.memberStatus(id, user.id)) !== "accepted") return reply({ error: "Accetta la richiesta per rispondere." });
      const partner = await db.directPartner(id, user.id);
      if (partner && (await db.blockedBy(user.id)).includes(partner)) {
        return reply({ error: "Hai bloccato questa persona: sbloccala per scriverle." });
      }
      if (partner && (await db.blockedBy(partner)).includes(user.id)) return reply({ error: "Non puoi scrivere a questa persona." });
      let attachment = null;
      if (attachmentId !== undefined && attachmentId !== null) {
        attachment = await db.attachmentInfo(toId(attachmentId) ?? 0);
        if (!attachment || attachment.conversationId !== id || attachment.userId !== user.id || attachment.used > 0) {
          return reply({ error: "Allegato non valido. Riprova a inviarlo." });
        }
      }
      if (!body && !attachment) return reply({ error: "Il messaggio è vuoto." });
      let replyTo = null;
      if (replyToId !== undefined && replyToId !== null) {
        const target = await db.getMessage(toId(replyToId) ?? 0);
        if (target && target.conversationId === id) replyTo = target.id;
      }
      const message = await db.addMessage(id, user.id, body, attachment, null, replyTo);
      reply({ message });
      const members = await db.memberIds(id);
      for (const m of members) io.to(userRoom(m)).emit("message:new", message);
      const others = members.filter((m) => m !== user.id && !isLooking(m));
      const pending = [];
      for (const m of others) if ((await db.memberStatus(id, m)) === "pending") pending.push(m);
      notify(id, message, others.filter((m) => !pending.includes(m)));
      // Message requests get a gentler notification that does not show the text.
      if (pending.length) {
        push.send(pending, {
          title: "Richiesta di messaggio", body: `${user.username} vuole scriverti`, conversationId: id, tag: `r${id}`,
        }).catch((err) => console.error(err));
      }
    });

    // Only the author can change a message: text edits within 24 hours,
    // deleting for everyone at any time.
    const ownMessage = async (messageId) => {
      const m = await db.getMessage(toId(messageId) ?? 0);
      if (!m || m.userId !== user.id) return { error: "Puoi modificare solo i tuoi messaggi." };
      if (m.kind === "call") return { error: "Le chiamate non si possono modificare." };
      if (m.deletedAt) return { error: "Il messaggio è già stato eliminato." };
      return { message: m };
    };

    handle("message:edit", async ({ messageId, text }, reply) => {
      const { message, error } = await ownMessage(messageId);
      if (error) return reply({ error });
      const body = typeof text === "string" ? text.trim() : "";
      if (!body && !message.attachment) return reply({ error: "Il messaggio non può restare vuoto." });
      if (body.length > MAX_MESSAGE) return reply({ error: `Il messaggio supera i ${MAX_MESSAGE} caratteri.` });
      if (Date.now() - message.createdAt > EDIT_WINDOW) return reply({ error: "Puoi modificare un messaggio solo entro 24 ore." });
      const updated = await db.editMessage(message.id, body);
      reply({ message: updated });
      await toMembers(updated.conversationId, "message:update", updated);
    });

    handle("message:delete", async ({ messageId }, reply) => {
      const { message, error } = await ownMessage(messageId);
      if (error) return reply({ error });
      const updated = await db.deleteMessage(message.id);
      reply({ message: updated });
      await toMembers(updated.conversationId, "message:update", updated);
    });

    // A reaction (one emoji per person; the same emoji again removes it).
    handle("message:react", async ({ messageId, emoji }, reply) => {
      const m = await db.getMessage(toId(messageId) ?? 0);
      if (!m || !(await db.isMember(m.conversationId, user.id)) || m.deletedAt) return reply({ error: "Messaggio non trovato." });
      if ((await db.memberStatus(m.conversationId, user.id)) !== "accepted") return reply({ error: "Accetta la richiesta per reagire." });
      const partner = await db.directPartner(m.conversationId, user.id);
      if (partner && (await db.eitherBlocked(user.id, partner))) return reply({ error: "Non puoi reagire in questa chat." });
      const value = typeof emoji === "string" && emoji.length > 0 && emoji.length <= 16 ? emoji : null;
      const mine = m.reactions.find((r) => r.userId === user.id);
      const next = value && mine?.emoji !== value ? value : null;
      const updated = await db.react(m.id, user.id, next);
      reply({ message: updated });
      await toMembers(updated.conversationId, "message:update", updated);
      if (next && m.userId !== user.id && !isLooking(m.userId)) {
        const what = m.text ? `«${m.text.slice(0, 60)}»` : "al tuo messaggio";
        push.send([m.userId], {
          title: user.username, body: `Ha reagito ${next} ${what}`, conversationId: m.conversationId, tag: `c${m.conversationId}`,
        }).catch((err) => console.error(err));
      }
    });

    calls.attach(socket, user, handle);

    handle("visibility", async ({ visible: on }) => {
      const sockets = visible.get(user.id) ?? new Map();
      if (on) sockets.set(socket.id, Date.now()); else sockets.delete(socket.id);
      visible.set(user.id, sockets);
    });

    // Someone who has not accepted a request does not reveal receipts or typing.
    const accepted = async (id) => (await db.memberStatus(id, user.id)) === "accepted";

    handle("delivered", async ({ conversationId, messageId }) => {
      const id = toId(conversationId), mid = toId(messageId);
      if (!id || !mid || !(await accepted(id))) return;
      await toMembers(id, "receipt", await db.markDelivered(id, user.id, mid));
    });

    handle("read", async ({ conversationId, messageId }) => {
      const id = toId(conversationId), mid = toId(messageId);
      if (!id || !mid || !(await accepted(id))) return;
      await toMembers(id, "receipt", await db.markRead(id, user.id, mid));
    });

    handle("typing", async ({ conversationId, typing }) => {
      const id = toId(conversationId);
      if (!id || !(await accepted(id))) return;
      const partner = await db.directPartner(id, user.id);
      if (partner && (await db.eitherBlocked(user.id, partner))) return;
      await toMembers(id, "typing", { conversationId: id, user, typing: Boolean(typing) }, user.id);
    });

    socket.on("disconnect", async () => {
      visible.get(user.id)?.delete(socket.id);
      const left = (online.get(user.id) ?? 1) - 1;
      if (left > 0) return online.set(user.id, left);
      online.delete(user.id);
      const lastSeen = Date.now();
      announcePresence(user.id, { userId: user.id, online: false, lastSeen }).catch((e) => console.error(e));
      try { await db.touchLastSeen(user.id); } catch (err) { console.error(err); }
    });
  });

  return { app, httpServer, io, db, calls };
}
