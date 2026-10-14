// Two tiny drivers with the same shape — query(sql, params) → rows — so the
// store writes each query once. SQL uses `?` placeholders.

export async function sqliteDriver(file) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  return {
    dialect: "sqlite",
    exec: async (sql) => db.exec(sql),
    query: async (sql, params = []) => db.prepare(sql).all(...params),
    close: async () => db.close(),
  };
}

export async function postgresDriver(connectionString) {
  const { default: pg } = await import("pg");
  pg.types.setTypeParser(20, Number); // BIGINT and count(*) as numbers
  const pool = new pg.Pool({ ...postgresConfig(connectionString), max: 5 });
  const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
  return {
    dialect: "postgres",
    exec: async (sql) => { await pool.query(sql); },
    query: async (sql, params = []) => (await pool.query(toPg(sql), params)).rows,
    close: () => pool.end(),
  };
}

// Hosted databases need SSL. Neon's links carry `sslmode` and a public
// certificate, so pg verifies them as usual. Supabase links carry no
// `sslmode` and its certificate comes from Supabase's own authority, so the
// connection is encrypted without checking that authority.
export function postgresConfig(connectionString) {
  const url = new URL(connectionString);
  const local = ["localhost", "127.0.0.1", "::1", ""].includes(url.hostname);
  const supabase = /\.supabase\.(co|com)$/.test(url.hostname);
  if (supabase) {
    url.searchParams.delete("sslmode");
    return { connectionString: url.toString(), ssl: { rejectUnauthorized: false } };
  }
  if (!local && !url.searchParams.has("sslmode")) return { connectionString, ssl: { rejectUnauthorized: false } };
  return { connectionString };
}
