// Every query the server needs, written once for both SQLite and Postgres.

const MESSAGE_SELECT = `
  SELECT m.id, m.conversation_id AS "conversationId", m.user_id AS "userId",
         CASE WHEN u.deleted_at IS NULL THEN u.username ELSE 'Account eliminato' END AS username,
         m.kind, m.text, m.created_at AS "createdAt", m.edited_at AS "editedAt", m.deleted_at AS "deletedAt",
         a.id AS "attId", a.mime AS "attMime", a.name AS "attName", a.size AS "attSize",
         a.width AS "attWidth", a.height AS "attHeight", a.duration AS "attDuration",
         r.id AS "repId", CASE WHEN ru.deleted_at IS NULL THEN ru.username ELSE 'Account eliminato' END AS "repUsername", r.user_id AS "repUserId", r.kind AS "repKind", r.text AS "repText",
         r.deleted_at AS "repDeletedAt"
  FROM chat_messages m
  JOIN users u ON u.id = m.user_id
  LEFT JOIN attachments a ON a.id = m.attachment_id
  LEFT JOIN chat_messages r ON r.id = m.reply_to_id
  LEFT JOIN users ru ON ru.id = r.user_id`;

// Flat SQL row -> message object with a nested attachment.
function toMessage(r) {
  if (!r) return r;
  const {
    attId, attMime, attName, attSize, attWidth, attHeight, attDuration,
    repId, repUsername, repUserId, repKind, repText, repDeletedAt, ...m
  } = r;
  return {
    ...m,
    // The message this one answers, shortened for the quote above the text.
    replyTo: repId
      ? {
          id: repId, userId: repUserId, username: repUsername, kind: repKind,
          text: repDeletedAt ? "" : String(repText ?? "").slice(0, 200), deleted: Boolean(repDeletedAt),
        }
      : null,
    attachment: attId
      ? { id: attId, mime: attMime, name: attName, size: attSize, width: attWidth, height: attHeight, duration: attDuration }
      : null,
  };
}

export const kindFor = (mime) =>
  mime.startsWith("image/") ? "image" : mime.startsWith("audio/") ? "audio" : "file";

export async function createStore(driver) {
  const { query, exec } = driver;
  const one = async (sql, params) => (await query(sql, params))[0];
  const pk = driver.dialect === "postgres" ? "SERIAL PRIMARY KEY" : "INTEGER PRIMARY KEY";
  const blob = driver.dialect === "postgres" ? "BYTEA" : "BLOB";

  await exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            ${pk},
      username      TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    BIGINT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS users_username ON users (lower(username));

    CREATE TABLE IF NOT EXISTS conversations (
      id         ${pk},
      is_group   INTEGER NOT NULL DEFAULT 0,
      name       TEXT,
      direct_key TEXT UNIQUE,
      created_by INTEGER REFERENCES users(id),
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS conversation_members (
      conversation_id   INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id           INTEGER NOT NULL REFERENCES users(id),
      last_read_id      INTEGER NOT NULL DEFAULT 0,
      last_delivered_id INTEGER NOT NULL DEFAULT 0,
      joined_at         BIGINT NOT NULL,
      PRIMARY KEY (conversation_id, user_id)
    );
    CREATE INDEX IF NOT EXISTS members_by_user ON conversation_members (user_id);

    CREATE TABLE IF NOT EXISTS chat_messages (
      id              ${pk},
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id         INTEGER NOT NULL REFERENCES users(id),
      text            TEXT NOT NULL,
      created_at      BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS chat_messages_by_conversation ON chat_messages (conversation_id, id);

    -- Photos, voice notes and files live in the database too, so a free host
    -- without a persistent disk keeps them.
    CREATE TABLE IF NOT EXISTS attachments (
      id              ${pk},
      conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      user_id         INTEGER NOT NULL REFERENCES users(id),
      mime            TEXT NOT NULL,
      name            TEXT NOT NULL,
      size            INTEGER NOT NULL,
      width           INTEGER,
      height          INTEGER,
      duration        INTEGER,
      data            ${blob} NOT NULL,
      created_at      BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      endpoint   TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS push_by_user ON push_subscriptions (user_id);

    CREATE TABLE IF NOT EXISTS avatars (
      user_id    INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      mime       TEXT NOT NULL,
      data       ${blob} NOT NULL,
      updated_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS blocks (
      blocker_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      blocked_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at BIGINT NOT NULL,
      PRIMARY KEY (blocker_id, blocked_id)
    );

    -- Single-use invitation codes: sign-up is by invitation only.
    CREATE TABLE IF NOT EXISTS invites (
      code       TEXT PRIMARY KEY,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at BIGINT NOT NULL,
      expires_at BIGINT NOT NULL,
      claimed_at BIGINT,
      used_by    INTEGER REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS invites_by_creator ON invites (created_by);

    -- One emoji per person per message.
    CREATE TABLE IF NOT EXISTS reactions (
      message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      emoji      TEXT NOT NULL,
      PRIMARY KEY (message_id, user_id)
    );

    -- One-time codes to set a new password, made by the admin or the inviter.
    CREATE TABLE IF NOT EXISTS password_resets (
      code       TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at BIGINT NOT NULL,
      used_at    BIGINT
    );

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  // Columns added after the first release; older databases get them here.
  for (const column of [
    "users ADD COLUMN last_seen BIGINT",
    "chat_messages ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'",
    "chat_messages ADD COLUMN attachment_id INTEGER REFERENCES attachments(id) ON DELETE SET NULL",
    "chat_messages ADD COLUMN edited_at BIGINT",
    "chat_messages ADD COLUMN deleted_at BIGINT",
    "users ADD COLUMN avatar_at BIGINT",
    // accepted | pending (a message request not answered yet) | declined
    "conversation_members ADD COLUMN status TEXT NOT NULL DEFAULT 'accepted'",
    "chat_messages ADD COLUMN reply_to_id INTEGER",
    "users ADD COLUMN deleted_at BIGINT",
    // Until when notifications from this chat stay silent (null: not muted).
    "conversation_members ADD COLUMN muted_until BIGINT",
    // Bumped when the password changes: older sessions stop working.
    "users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0",
  ]) {
    try { await exec(`ALTER TABLE ${column}`); } catch { /* already there */ }
  }

  // Adds `reactions: [{ userId, username, emoji }]` to each message.
  async function withReactions(list) {
    if (!list.length) return list;
    const ids = list.map((m) => m.id);
    const rows = await query(
      `SELECT r.message_id AS "messageId", r.user_id AS "userId", u.username, r.emoji
       FROM reactions r JOIN users u ON u.id = r.user_id
       WHERE r.message_id IN (${ids.map(() => "?").join(",")})`, ids);
    const by = new Map();
    for (const r of rows) {
      if (!by.has(r.messageId)) by.set(r.messageId, []);
      by.get(r.messageId).push({ userId: r.userId, username: r.username, emoji: r.emoji });
    }
    return list.map((m) => ({ ...m, reactions: by.get(m.id) ?? [] }));
  }

  const store = {
    close: driver.close,

    // ---------- users ----------
    createUser: (username, hash) =>
      one("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?) RETURNING id, username",
        [username, hash, Date.now()]),
    findUserByName: (username) => one("SELECT * FROM users WHERE lower(username) = lower(?)", [username]),
    findUserById: (id) => one(`SELECT id, username, last_seen AS "lastSeen", avatar_at AS "avatarAt" FROM users WHERE id = ?`, [id]),
    // Only an exact username finds someone: nobody can browse who is signed up.
    findByExactName: (q, exceptId) =>
      query(`SELECT id, username, last_seen AS "lastSeen", avatar_at AS "avatarAt" FROM users
             WHERE id <> ? AND lower(username) = lower(?) AND deleted_at IS NULL`, [exceptId, q]),
    // People you already talk to: both sides accepted a private chat.
    contacts: (userId) =>
      query(`SELECT u.id, u.username, u.last_seen AS "lastSeen", u.avatar_at AS "avatarAt"
             FROM conversations c
             JOIN conversation_members me ON me.conversation_id = c.id AND me.user_id = ? AND me.status = 'accepted'
             JOIN conversation_members o ON o.conversation_id = c.id AND o.user_id <> ? AND o.status = 'accepted'
             JOIN users u ON u.id = o.user_id
             WHERE c.is_group = 0 AND u.deleted_at IS NULL ORDER BY lower(u.username)`, [userId, userId]),
    touchLastSeen: (userId) => query("UPDATE users SET last_seen = ? WHERE id = ?", [Date.now(), userId]),

    // ---------- conversations ----------
    isMember: async (conversationId, userId) =>
      Boolean(await one("SELECT 1 AS ok FROM conversation_members WHERE conversation_id = ? AND user_id = ?",
        [conversationId, userId])),
    conversationMeta: async (id) => {
      const r = await one("SELECT is_group AS \"isGroup\", name FROM conversations WHERE id = ?", [id]);
      return r && { isGroup: Boolean(r.isGroup), name: r.name };
    },
    // Members who have not declined the conversation.
    memberIds: async (conversationId) =>
      (await query("SELECT user_id AS id FROM conversation_members WHERE conversation_id = ? AND status <> 'declined'", [conversationId]))
        .map((r) => r.id),
    // Who may see someone's online status: people sharing a chat both accepted.
    audience: async (userId) =>
      (await query(`SELECT DISTINCT o.user_id AS id FROM conversation_members me
                    JOIN conversation_members o ON o.conversation_id = me.conversation_id AND o.user_id <> me.user_id
                    WHERE me.user_id = ? AND me.status = 'accepted' AND o.status = 'accepted'`, [userId])).map((r) => r.id),
    // Who sees someone's photo change live: anyone in a chat with them.
    coMembers: async (userId) =>
      (await query(`SELECT DISTINCT o.user_id AS id FROM conversation_members me
                    JOIN conversation_members o ON o.conversation_id = me.conversation_id AND o.user_id <> me.user_id
                    WHERE me.user_id = ? AND me.status <> 'declined' AND o.status <> 'declined'`, [userId])).map((r) => r.id),

    findDirect: async (a, b) => {
      const key = [a, b].sort((x, y) => x - y).join(":");
      return { id: (await one("SELECT id FROM conversations WHERE direct_key = ?", [key]))?.id ?? null };
    },

    async findOrCreateDirect(userId, otherId) {
      const key = [userId, otherId].sort((a, b) => a - b).join(":");
      const found = await one("SELECT id FROM conversations WHERE direct_key = ?", [key]);
      if (found) return { id: found.id, created: false };
      const now = Date.now();
      const c = await one(
        `INSERT INTO conversations (is_group, direct_key, created_by, created_at) VALUES (0, ?, ?, ?)
         ON CONFLICT (direct_key) DO NOTHING RETURNING id`, [key, userId, now]);
      if (!c) return { id: (await one("SELECT id FROM conversations WHERE direct_key = ?", [key])).id, created: false };
      // The person who writes first is in; the other gets a message request.
      await query("INSERT INTO conversation_members (conversation_id, user_id, joined_at, status) VALUES (?, ?, ?, 'accepted')", [c.id, userId, now]);
      await query("INSERT INTO conversation_members (conversation_id, user_id, joined_at, status) VALUES (?, ?, ?, 'pending')", [c.id, otherId, now]);
      return { id: c.id, created: true };
    },

    async createGroup(name, creatorId, userIds) {
      const now = Date.now();
      const c = await one("INSERT INTO conversations (is_group, name, created_by, created_at) VALUES (1, ?, ?, ?) RETURNING id",
        [name, creatorId, now]);
      // Contacts join straight away; anyone else finds the group in their requests.
      const contactIds = new Set((await store.contacts(creatorId)).map((u) => u.id));
      for (const id of new Set([creatorId, ...userIds])) {
        const status = id === creatorId || contactIds.has(id) ? "accepted" : "pending";
        await query("INSERT INTO conversation_members (conversation_id, user_id, joined_at, status) VALUES (?, ?, ?, ?)",
          [c.id, id, now, status]);
      }
      return c.id;
    },

    // All conversations of a user, newest activity first, each with its
    // members (and their receipts), last message and unread count.
    async conversationsFor(userId, onlyId) {
      const filter = onlyId ? "AND c.id = ?" : "";
      const params = onlyId ? [userId, onlyId] : [userId];
      const convs = await query(
        `SELECT c.id, c.is_group AS "isGroup", c.name, c.created_at AS "createdAt", me.status AS "myStatus",
                c.created_by AS "createdBy", me.muted_until AS "mutedUntil"
         FROM conversations c JOIN conversation_members me ON me.conversation_id = c.id AND me.user_id = ?
         WHERE me.status <> 'declined' ${filter}`, params);
      if (!convs.length) return [];
      const ids = convs.map((c) => c.id);
      const inList = ids.map(() => "?").join(",");

      const members = await query(
        `SELECT cm.conversation_id AS "conversationId", u.id,
                CASE WHEN u.deleted_at IS NULL THEN u.username ELSE 'Account eliminato' END AS username, u.last_seen AS "lastSeen", u.avatar_at AS "avatarAt",
                cm.last_read_id AS "lastReadId", cm.last_delivered_id AS "lastDeliveredId", cm.status,
                u.deleted_at AS "deletedAt"
         FROM conversation_members cm JOIN users u ON u.id = cm.user_id
         WHERE cm.conversation_id IN (${inList})`, ids);
      const last = (await query(
        `${MESSAGE_SELECT}
         WHERE m.id IN (SELECT max(id) FROM chat_messages WHERE conversation_id IN (${inList}) GROUP BY conversation_id)`, ids))
        .map(toMessage);
      const unread = await query(
        `SELECT m.conversation_id AS "conversationId", count(*) AS n
         FROM chat_messages m JOIN conversation_members me ON me.conversation_id = m.conversation_id AND me.user_id = ?
         WHERE m.conversation_id IN (${inList}) AND m.id > me.last_read_id AND m.user_id <> ? AND m.deleted_at IS NULL
           AND m.kind <> 'system'
         GROUP BY m.conversation_id`, [userId, ...ids, userId]);

      return convs.map((c) => {
        const lastMessage = last.find((m) => m.conversationId === c.id) ?? null;
        return {
          id: c.id,
          isGroup: Boolean(c.isGroup),
          name: c.name,
          myStatus: c.myStatus,
          createdBy: c.createdBy,
          mutedUntil: c.mutedUntil && c.mutedUntil > Date.now() ? c.mutedUntil : null,
          members: members.filter((m) => m.conversationId === c.id)
            .map(({ conversationId, deletedAt, ...m }) => ({ ...m, deleted: Boolean(deletedAt) })),
          lastMessage,
          unread: unread.find((u) => u.conversationId === c.id)?.n ?? 0,
          updatedAt: lastMessage?.createdAt ?? c.createdAt,
        };
      }).sort((a, b) => b.updatedAt - a.updatedAt);
    },

    // ---------- groups ----------
    renameGroup: (id, name) => query("UPDATE conversations SET name = ? WHERE id = ? AND is_group = 1", [name, id]),
    groupAdmin: async (id) => (await one("SELECT created_by AS id FROM conversations WHERE id = ?", [id]))?.id ?? null,
    // New people: contacts of whoever adds them join directly, others get a request.
    async addMembers(id, byUserId, userIds) {
      const contactIds = new Set((await store.contacts(byUserId)).map((u) => u.id));
      const added = [];
      for (const uid of userIds) {
        const status = contactIds.has(uid) ? "accepted" : "pending";
        const current = await store.memberStatus(id, uid);
        if (current === "accepted" || current === "pending") continue;
        if (current === "declined") await store.setMemberStatus(id, uid, status);
        else await query("INSERT INTO conversation_members (conversation_id, user_id, joined_at, status) VALUES (?, ?, ?, ?)", [id, uid, Date.now(), status]);
        added.push(uid);
      }
      return added;
    },
    // Leaving or being removed; the admin role passes to the longest-standing member.
    async removeMember(id, userId) {
      await query("DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?", [id, userId]);
      if ((await store.groupAdmin(id)) === userId) {
        const next = await one(`SELECT user_id AS id FROM conversation_members WHERE conversation_id = ? AND status = 'accepted'
                                ORDER BY joined_at, user_id LIMIT 1`, [id]);
        await query("UPDATE conversations SET created_by = ? WHERE id = ?", [next?.id ?? null, id]);
      }
    },
    memberCount: async (id) =>
      (await one("SELECT count(*) AS n FROM conversation_members WHERE conversation_id = ? AND status <> 'declined'", [id]))?.n ?? 0,

    // ---------- muting ----------
    setMuted: (id, userId, until) =>
      query("UPDATE conversation_members SET muted_until = ? WHERE conversation_id = ? AND user_id = ?", [until, id, userId]),
    mutedIn: async (id) =>
      (await query("SELECT user_id AS id FROM conversation_members WHERE conversation_id = ? AND muted_until > ?", [id, Date.now()]))
        .map((r) => r.id),

    // ---------- search ----------
    // Text (and photo captions) in my accepted chats, newest first.
    searchMessages: async (userId, q, limit = 40) => {
      const pattern = `%${q.toLowerCase().replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
      const rows = await query(
        `${MESSAGE_SELECT}
         JOIN conversation_members me ON me.conversation_id = m.conversation_id AND me.user_id = ? AND me.status = 'accepted'
         WHERE m.deleted_at IS NULL AND m.kind IN ('text', 'image') AND lower(m.text) LIKE ? ESCAPE '\\'
         ORDER BY m.id DESC LIMIT ?`, [userId, pattern, limit]);
      return rows.map(toMessage);
    },

    // ---------- deleting an account ----------
    // Messages already sent stay with the people who received them, like on a
    // phone; the account itself becomes "Account eliminato" and can't sign in.
    async deleteAccount(userId) {
      await query(`UPDATE users SET username = ?, password_hash = '!', deleted_at = ?, avatar_at = NULL,
                   token_version = token_version + 1 WHERE id = ?`, [`Account eliminato ${userId}`, Date.now(), userId]);
      await query("DELETE FROM avatars WHERE user_id = ?", [userId]);
      await query("DELETE FROM push_subscriptions WHERE user_id = ?", [userId]);
      await query("DELETE FROM reactions WHERE user_id = ?", [userId]);
      await query("DELETE FROM blocks WHERE blocker_id = ? OR blocked_id = ?", [userId, userId]);
      await query("DELETE FROM invites WHERE created_by = ? AND used_by IS NULL", [userId]);
      await query("DELETE FROM password_resets WHERE user_id = ? OR created_by = ?", [userId, userId]);
      const groups = await query(`SELECT cm.conversation_id AS id FROM conversation_members cm
                                  JOIN conversations c ON c.id = cm.conversation_id WHERE cm.user_id = ? AND c.is_group = 1`, [userId]);
      for (const g of groups) await store.removeMember(g.id, userId);
      return groups.map((g) => g.id);
    },
    isDeleted: async (userId) => Boolean((await one("SELECT deleted_at AS d FROM users WHERE id = ?", [userId]))?.d),

    memberStatus: async (conversationId, userId) =>
      (await one("SELECT status FROM conversation_members WHERE conversation_id = ? AND user_id = ?", [conversationId, userId]))?.status ?? null,
    setMemberStatus: (conversationId, userId, status) =>
      query("UPDATE conversation_members SET status = ? WHERE conversation_id = ? AND user_id = ?", [status, conversationId, userId]),
    directPartner: async (conversationId, userId) =>
      (await one(`SELECT cm.user_id AS id FROM conversation_members cm JOIN conversations c ON c.id = cm.conversation_id
                  WHERE cm.conversation_id = ? AND cm.user_id <> ? AND c.is_group = 0`, [conversationId, userId]))?.id ?? null,

    // ---------- blocking ----------
    block: (blockerId, blockedId) =>
      query("INSERT INTO blocks (blocker_id, blocked_id, created_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
        [blockerId, blockedId, Date.now()]),
    unblock: (blockerId, blockedId) => query("DELETE FROM blocks WHERE blocker_id = ? AND blocked_id = ?", [blockerId, blockedId]),
    blockedBy: async (blockerId) =>
      (await query("SELECT blocked_id AS id FROM blocks WHERE blocker_id = ?", [blockerId])).map((r) => r.id),
    blockersOf: async (blockedId) =>
      (await query("SELECT blocker_id AS id FROM blocks WHERE blocked_id = ?", [blockedId])).map((r) => r.id),
    eitherBlocked: async (a, b) =>
      Boolean(await one("SELECT 1 AS x FROM blocks WHERE (blocker_id = ? AND blocked_id = ?) OR (blocker_id = ? AND blocked_id = ?)", [a, b, b, a])),

    // ---------- messages ----------
    async addMessage(conversationId, userId, text, attachment = null, kind = null, replyToId = null) {
      const { id } = await one(
        `INSERT INTO chat_messages (conversation_id, user_id, kind, text, attachment_id, created_at, reply_to_id)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        [conversationId, userId, kind ?? (attachment ? kindFor(attachment.mime) : "text"), text, attachment?.id ?? null, Date.now(),
          replyToId]);
      // The sender has obviously read everything up to their own message.
      await store.markRead(conversationId, userId, id);
      return store.getMessage(id);
    },
    getMessage: async (id) => {
      const m = toMessage(await one(`${MESSAGE_SELECT} WHERE m.id = ?`, [id]));
      return m && (await withReactions([m]))[0];
    },

    // Newest first from the DB, returned oldest first for display.
    async messages(conversationId, before = 2147483647, limit = 50) {
      const rows = await query(`${MESSAGE_SELECT} WHERE m.conversation_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`,
        [conversationId, before, limit]);
      return withReactions(rows.reverse().map(toMessage));
    },

    // emoji null removes my reaction.
    async react(messageId, userId, emoji) {
      await query("DELETE FROM reactions WHERE message_id = ? AND user_id = ?", [messageId, userId]);
      if (emoji) await query("INSERT INTO reactions (message_id, user_id, emoji) VALUES (?, ?, ?)", [messageId, userId, emoji]);
      return store.getMessage(messageId);
    },

    async editMessage(id, text) {
      await query("UPDATE chat_messages SET text = ?, edited_at = ? WHERE id = ?", [text, Date.now(), id]);
      return store.getMessage(id);
    },

    // "Deleted for everyone": keep a placeholder, drop the text and the file.
    async deleteMessage(id) {
      const row = await one("SELECT attachment_id AS \"attachmentId\" FROM chat_messages WHERE id = ?", [id]);
      await query("UPDATE chat_messages SET text = '', attachment_id = NULL, deleted_at = ? WHERE id = ?", [Date.now(), id]);
      await query("DELETE FROM reactions WHERE message_id = ?", [id]);
      if (row?.attachmentId) await query("DELETE FROM attachments WHERE id = ?", [row.attachmentId]);
      return store.getMessage(id);
    },

    // ---------- attachments ----------
    async createAttachment({ conversationId, userId, mime, name, data, width, height, duration }) {
      const { id } = await one(
        `INSERT INTO attachments (conversation_id, user_id, mime, name, size, width, height, duration, data, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`,
        [conversationId, userId, mime, name, data.length, width ?? null, height ?? null, duration ?? null, data, Date.now()]);
      return { id, mime, name, size: data.length, width: width ?? null, height: height ?? null, duration: duration ?? null };
    },
    // Metadata only, to check who may use it.
    attachmentInfo: (id) =>
      one(`SELECT a.id, a.conversation_id AS "conversationId", a.user_id AS "userId", a.mime, a.name,
                  (SELECT count(*) FROM chat_messages m WHERE m.attachment_id = a.id) AS used
           FROM attachments a WHERE a.id = ?`, [id]),
    attachmentData: async (id) => {
      const r = await one(`SELECT conversation_id AS "conversationId", mime, name, size, data FROM attachments WHERE id = ?`, [id]);
      return r && { ...r, data: Buffer.from(r.data) };
    },

    // ---------- push notifications ----------
    async savePushSubscription(userId, { endpoint, keys }) {
      await query(
        `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
        [endpoint, userId, keys.p256dh, keys.auth, Date.now()]);
    },
    deletePushSubscription: (endpoint) => query("DELETE FROM push_subscriptions WHERE endpoint = ?", [endpoint]),
    pushSubscriptionsFor: async (userIds) => {
      if (!userIds.length) return [];
      return query(`SELECT endpoint, user_id AS "userId", p256dh, auth FROM push_subscriptions
                    WHERE user_id IN (${userIds.map(() => "?").join(",")})`, userIds);
    },

    // ---------- profile photos ----------
    // The photo's timestamp doubles as its version in URLs, so browsers can cache it forever.
    async setAvatar(userId, mime, data) {
      const at = Date.now();
      await query(
        `INSERT INTO avatars (user_id, mime, data, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at`,
        [userId, mime, data, at]);
      await query("UPDATE users SET avatar_at = ? WHERE id = ?", [at, userId]);
      return at;
    },
    async removeAvatar(userId) {
      await query("DELETE FROM avatars WHERE user_id = ?", [userId]);
      await query("UPDATE users SET avatar_at = NULL WHERE id = ?", [userId]);
    },
    getAvatar: async (userId) => {
      const r = await one("SELECT mime, data FROM avatars WHERE user_id = ?", [userId]);
      return r && { mime: r.mime, data: Buffer.from(r.data) };
    },

    // ---------- invitations ----------
    countUsers: async () => (await one("SELECT count(*) AS n FROM users"))?.n ?? 0,
    createInvite: async (code, userId, ttlMs) => {
      const now = Date.now();
      await query("INSERT INTO invites (code, created_by, created_at, expires_at) VALUES (?, ?, ?, ?)", [code, userId, now, now + ttlMs]);
      return { code, createdAt: now, expiresAt: now + ttlMs, usedBy: null };
    },
    getInvite: (code) =>
      one(`SELECT i.code, i.created_by AS "createdBy", u.username AS "inviter", i.expires_at AS "expiresAt",
                  i.claimed_at AS "claimedAt", i.used_by AS "usedBy"
           FROM invites i JOIN users u ON u.id = i.created_by WHERE i.code = ?`, [code]),
    listInvites: (userId) =>
      query(`SELECT i.code, i.created_at AS "createdAt", i.expires_at AS "expiresAt", i.used_by AS "usedBy",
                    u.username AS "usedByName"
             FROM invites i LEFT JOIN users u ON u.id = i.used_by
             WHERE i.created_by = ? ORDER BY i.created_at DESC LIMIT 50`, [userId]),
    countOpenInvites: async (userId) =>
      (await one("SELECT count(*) AS n FROM invites WHERE created_by = ? AND claimed_at IS NULL AND expires_at > ?", [userId, Date.now()]))?.n ?? 0,
    // Takes the code for one sign-up; only one person can win a race for it.
    claimInvite: async (code) =>
      (await one(`UPDATE invites SET claimed_at = ? WHERE code = ? AND claimed_at IS NULL AND expires_at > ?
                  RETURNING created_by AS "createdBy"`, [Date.now(), code, Date.now()]))?.createdBy ?? null,
    releaseInvite: (code) => query("UPDATE invites SET claimed_at = NULL WHERE code = ? AND used_by IS NULL", [code]),
    completeInvite: (code, userId) => query("UPDATE invites SET used_by = ? WHERE code = ?", [userId, code]),
    deleteInvite: async (code, userId) =>
      (await query("DELETE FROM invites WHERE code = ? AND created_by = ? AND claimed_at IS NULL RETURNING code", [code, userId])).length > 0,

    // ---------- passwords ----------
    tokenVersion: async (userId) =>
      (await one("SELECT token_version AS v FROM users WHERE id = ?", [userId]))?.v ?? null,
    setPassword: async (userId, hash) =>
      (await one("UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ? RETURNING token_version AS v",
        [hash, userId]))?.v,
    adminId: async () => (await one("SELECT min(id) AS id FROM users WHERE deleted_at IS NULL"))?.id ?? null,
    inviterOf: async (userId) => (await one("SELECT created_by AS id FROM invites WHERE used_by = ?", [userId]))?.id ?? null,
    createPasswordReset: async (code, userId, createdBy, ttlMs) => {
      await query("DELETE FROM password_resets WHERE user_id = ? AND used_at IS NULL", [userId]);
      await query("INSERT INTO password_resets (code, user_id, created_by, expires_at) VALUES (?, ?, ?, ?)",
        [code, userId, createdBy, Date.now() + ttlMs]);
    },
    // Uses the code once; returns the account it belongs to.
    usePasswordReset: async (code, userId) =>
      (await one(`UPDATE password_resets SET used_at = ? WHERE code = ? AND user_id = ? AND used_at IS NULL AND expires_at > ?
                  RETURNING user_id AS "userId"`, [Date.now(), code, userId, Date.now()]))?.userId ?? null,

    // ---------- settings ----------
    getSetting: async (key) => (await one("SELECT value FROM settings WHERE key = ?", [key]))?.value ?? null,
    setSetting: (key, value) =>
      query("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", [key, value]),

    // Receipts only move forward. Returns the member's receipt row.
    async markDelivered(conversationId, userId, messageId) {
      await query(
        `UPDATE conversation_members SET last_delivered_id = ?
         WHERE conversation_id = ? AND user_id = ? AND last_delivered_id < ?`,
        [messageId, conversationId, userId, messageId]);
      return store.receipt(conversationId, userId);
    },
    async markRead(conversationId, userId, messageId) {
      await query(
        `UPDATE conversation_members
         SET last_read_id = CASE WHEN last_read_id < ? THEN ? ELSE last_read_id END,
             last_delivered_id = CASE WHEN last_delivered_id < ? THEN ? ELSE last_delivered_id END
         WHERE conversation_id = ? AND user_id = ?`,
        [messageId, messageId, messageId, messageId, conversationId, userId]);
      return store.receipt(conversationId, userId);
    },
    receipt: (conversationId, userId) =>
      one(`SELECT conversation_id AS "conversationId", user_id AS "userId",
                  last_read_id AS "lastReadId", last_delivered_id AS "lastDeliveredId"
           FROM conversation_members WHERE conversation_id = ? AND user_id = ?`, [conversationId, userId]),
  };
  return store;
}
