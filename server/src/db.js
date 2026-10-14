import { DatabaseSync } from "node:sqlite";

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY,
      username      TEXT NOT NULL UNIQUE COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      created_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS channels (
      id         INTEGER PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id),
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id         INTEGER PRIMARY KEY,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      text       TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS messages_by_channel ON messages(channel_id, id);
  `);

  db.prepare("INSERT OR IGNORE INTO channels (name, created_at) VALUES (?, ?)").run("generale", Date.now());

  const q = {
    insertUser: db.prepare("INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?) RETURNING id, username"),
    userByName: db.prepare("SELECT * FROM users WHERE username = ?"),
    userById: db.prepare("SELECT id, username FROM users WHERE id = ?"),
    listChannels: db.prepare("SELECT id, name, created_at AS createdAt FROM channels ORDER BY id"),
    channelById: db.prepare("SELECT id, name, created_at AS createdAt FROM channels WHERE id = ?"),
    insertChannel: db.prepare("INSERT INTO channels (name, created_by, created_at) VALUES (?, ?, ?) RETURNING id, name, created_at AS createdAt"),
    insertMessage: db.prepare("INSERT INTO messages (channel_id, user_id, text, created_at) VALUES (?, ?, ?, ?) RETURNING id"),
    messageById: db.prepare(`
      SELECT m.id, m.channel_id AS channelId, m.text, m.created_at AS createdAt,
             u.id AS userId, u.username
      FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id = ?`),
    messagesBefore: db.prepare(`
      SELECT m.id, m.channel_id AS channelId, m.text, m.created_at AS createdAt,
             u.id AS userId, u.username
      FROM messages m JOIN users u ON u.id = m.user_id
      WHERE m.channel_id = ? AND m.id < ?
      ORDER BY m.id DESC LIMIT ?`),
  };

  return {
    raw: db,
    createUser: (username, hash) => q.insertUser.get(username, hash, Date.now()),
    findUserByName: (username) => q.userByName.get(username),
    findUserById: (id) => q.userById.get(id),
    listChannels: () => q.listChannels.all(),
    findChannel: (id) => q.channelById.get(id),
    createChannel: (name, userId) => q.insertChannel.get(name, userId, Date.now()),
    addMessage(channelId, userId, text) {
      const { id } = q.insertMessage.get(channelId, userId, text, Date.now());
      return q.messageById.get(id);
    },
    // Newest first from the DB, returned oldest first for display.
    messages: (channelId, before = Number.MAX_SAFE_INTEGER, limit = 50) =>
      q.messagesBefore.all(channelId, before, limit).reverse(),
  };
}
