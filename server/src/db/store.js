// Every query the server needs, written once for both SQLite and Postgres.

const MESSAGE_SELECT = `
  SELECT m.id, m.conversation_id AS "conversationId", m.user_id AS "userId", u.username,
         m.kind, m.text, m.created_at AS "createdAt", m.edited_at AS "editedAt", m.deleted_at AS "deletedAt",
         a.id AS "attId", a.mime AS "attMime", a.name AS "attName", a.size AS "attSize",
         a.width AS "attWidth", a.height AS "attHeight", a.duration AS "attDuration"
  FROM chat_messages m
  JOIN users u ON u.id = m.user_id
  LEFT JOIN attachments a ON a.id = m.attachment_id`;

// Flat SQL row -> message object with a nested attachment.
function toMessage(r) {
  if (!r) return r;
  const { attId, attMime, attName, attSize, attWidth, attHeight, attDuration, ...m } = r;
  return {
    ...m,
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
  ]) {
    try { await exec(`ALTER TABLE ${column}`); } catch { /* already there */ }
  }

  const store = {
    close: driver.close,

    // ---------- users ----------
    createUser: (username, hash) =>
      one("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?) RETURNING id, username",
        [username, hash, Date.now()]),
    findUserByName: (username) => one("SELECT * FROM users WHERE lower(username) = lower(?)", [username]),
    findUserById: (id) => one(`SELECT id, username, last_seen AS "lastSeen" FROM users WHERE id = ?`, [id]),
    searchUsers: (q, exceptId) =>
      query(`SELECT id, username, last_seen AS "lastSeen" FROM users
             WHERE id <> ? AND lower(username) LIKE lower(?) ORDER BY lower(username) LIMIT 30`,
        [exceptId, `%${q.replace(/[%_]/g, "")}%`]),
    touchLastSeen: (userId) => query("UPDATE users SET last_seen = ? WHERE id = ?", [Date.now(), userId]),

    // ---------- conversations ----------
    isMember: async (conversationId, userId) =>
      Boolean(await one("SELECT 1 AS ok FROM conversation_members WHERE conversation_id = ? AND user_id = ?",
        [conversationId, userId])),
    conversationMeta: async (id) => {
      const r = await one("SELECT is_group AS \"isGroup\", name FROM conversations WHERE id = ?", [id]);
      return r && { isGroup: Boolean(r.isGroup), name: r.name };
    },
    memberIds: async (conversationId) =>
      (await query("SELECT user_id AS id FROM conversation_members WHERE conversation_id = ?", [conversationId]))
        .map((r) => r.id),

    async findOrCreateDirect(userId, otherId) {
      const key = [userId, otherId].sort((a, b) => a - b).join(":");
      const found = await one("SELECT id FROM conversations WHERE direct_key = ?", [key]);
      if (found) return { id: found.id, created: false };
      const now = Date.now();
      const c = await one(
        `INSERT INTO conversations (is_group, direct_key, created_by, created_at) VALUES (0, ?, ?, ?)
         ON CONFLICT (direct_key) DO NOTHING RETURNING id`, [key, userId, now]);
      if (!c) return { id: (await one("SELECT id FROM conversations WHERE direct_key = ?", [key])).id, created: false };
      for (const id of [userId, otherId]) {
        await query("INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)", [c.id, id, now]);
      }
      return { id: c.id, created: true };
    },

    async createGroup(name, creatorId, userIds) {
      const now = Date.now();
      const c = await one("INSERT INTO conversations (is_group, name, created_by, created_at) VALUES (1, ?, ?, ?) RETURNING id",
        [name, creatorId, now]);
      for (const id of new Set([creatorId, ...userIds])) {
        await query("INSERT INTO conversation_members (conversation_id, user_id, joined_at) VALUES (?, ?, ?)", [c.id, id, now]);
      }
      return c.id;
    },

    // All conversations of a user, newest activity first, each with its
    // members (and their receipts), last message and unread count.
    async conversationsFor(userId, onlyId) {
      const filter = onlyId ? "AND c.id = ?" : "";
      const params = onlyId ? [userId, onlyId] : [userId];
      const convs = await query(
        `SELECT c.id, c.is_group AS "isGroup", c.name, c.created_at AS "createdAt"
         FROM conversations c JOIN conversation_members me ON me.conversation_id = c.id AND me.user_id = ?
         WHERE 1 = 1 ${filter}`, params);
      if (!convs.length) return [];
      const ids = convs.map((c) => c.id);
      const inList = ids.map(() => "?").join(",");

      const members = await query(
        `SELECT cm.conversation_id AS "conversationId", u.id, u.username, u.last_seen AS "lastSeen",
                cm.last_read_id AS "lastReadId", cm.last_delivered_id AS "lastDeliveredId"
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
         GROUP BY m.conversation_id`, [userId, ...ids, userId]);

      return convs.map((c) => {
        const lastMessage = last.find((m) => m.conversationId === c.id) ?? null;
        return {
          id: c.id,
          isGroup: Boolean(c.isGroup),
          name: c.name,
          members: members.filter((m) => m.conversationId === c.id).map(({ conversationId, ...m }) => m),
          lastMessage,
          unread: unread.find((u) => u.conversationId === c.id)?.n ?? 0,
          updatedAt: lastMessage?.createdAt ?? c.createdAt,
        };
      }).sort((a, b) => b.updatedAt - a.updatedAt);
    },

    // ---------- messages ----------
    async addMessage(conversationId, userId, text, attachment = null, kind = null) {
      const { id } = await one(
        `INSERT INTO chat_messages (conversation_id, user_id, kind, text, attachment_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?) RETURNING id`,
        [conversationId, userId, kind ?? (attachment ? kindFor(attachment.mime) : "text"), text, attachment?.id ?? null, Date.now()]);
      // The sender has obviously read everything up to their own message.
      await store.markRead(conversationId, userId, id);
      return store.getMessage(id);
    },
    getMessage: async (id) => toMessage(await one(`${MESSAGE_SELECT} WHERE m.id = ?`, [id])),

    // Newest first from the DB, returned oldest first for display.
    async messages(conversationId, before = 2147483647, limit = 50) {
      const rows = await query(`${MESSAGE_SELECT} WHERE m.conversation_id = ? AND m.id < ? ORDER BY m.id DESC LIMIT ?`,
        [conversationId, before, limit]);
      return rows.reverse().map(toMessage);
    },

    async editMessage(id, text) {
      await query("UPDATE chat_messages SET text = ?, edited_at = ? WHERE id = ?", [text, Date.now(), id]);
      return store.getMessage(id);
    },

    // "Deleted for everyone": keep a placeholder, drop the text and the file.
    async deleteMessage(id) {
      const row = await one("SELECT attachment_id AS \"attachmentId\" FROM chat_messages WHERE id = ?", [id]);
      await query("UPDATE chat_messages SET text = '', attachment_id = NULL, deleted_at = ? WHERE id = ?", [Date.now(), id]);
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
