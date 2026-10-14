import pg from "pg";

// BIGINT (timestamps in ms) comes back as a string by default.
pg.types.setTypeParser(20, Number);

const MESSAGE_COLUMNS = `
  m.id, m.channel_id AS "channelId", m.text, m.created_at AS "createdAt",
  u.id AS "userId", u.username`;

// Same interface as the SQLite store, backed by a hosted Postgres (e.g. Neon)
// so messages survive restarts of free hosting plans.
export async function openPostgres(connectionString) {
  const pool = new pg.Pool({ connectionString, max: 5 });
  const one = async (sql, params) => (await pool.query(sql, params)).rows[0];
  const all = async (sql, params) => (await pool.query(sql, params)).rows;

  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id            SERIAL PRIMARY KEY,
      username      TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at    BIGINT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS users_username ON users (lower(username));

    CREATE TABLE IF NOT EXISTS channels (
      id         SERIAL PRIMARY KEY,
      name       TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id),
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id         SERIAL PRIMARY KEY,
      channel_id INTEGER NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      user_id    INTEGER NOT NULL REFERENCES users(id),
      text       TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS messages_by_channel ON messages (channel_id, id);

    INSERT INTO channels (name, created_at)
      VALUES ('generale', (extract(epoch FROM now()) * 1000)::bigint)
      ON CONFLICT (name) DO NOTHING;
  `);

  return {
    close: () => pool.end(),
    createUser: (username, hash) =>
      one("INSERT INTO users (username, password_hash, created_at) VALUES ($1, $2, $3) RETURNING id, username",
        [username, hash, Date.now()]),
    findUserByName: (username) => one("SELECT * FROM users WHERE lower(username) = lower($1)", [username]),
    findUserById: (id) => one("SELECT id, username FROM users WHERE id = $1", [id]),
    listChannels: () => all(`SELECT id, name, created_at AS "createdAt" FROM channels ORDER BY id`),
    findChannel: (id) => one(`SELECT id, name, created_at AS "createdAt" FROM channels WHERE id = $1`, [id]),
    createChannel: (name, userId) =>
      one(`INSERT INTO channels (name, created_by, created_at) VALUES ($1, $2, $3)
           RETURNING id, name, created_at AS "createdAt"`, [name, userId, Date.now()]),
    async addMessage(channelId, userId, text) {
      const { id } = await one(
        "INSERT INTO messages (channel_id, user_id, text, created_at) VALUES ($1, $2, $3, $4) RETURNING id",
        [channelId, userId, text, Date.now()]);
      return one(`SELECT ${MESSAGE_COLUMNS} FROM messages m JOIN users u ON u.id = m.user_id WHERE m.id = $1`, [id]);
    },
    // Newest first from the DB, returned oldest first for display.
    async messages(channelId, before = 2147483647, limit = 50) {
      const rows = await all(
        `SELECT ${MESSAGE_COLUMNS} FROM messages m JOIN users u ON u.id = m.user_id
         WHERE m.channel_id = $1 AND m.id < $2 ORDER BY m.id DESC LIMIT $3`,
        [channelId, before, limit]);
      return rows.reverse();
    },
  };
}
