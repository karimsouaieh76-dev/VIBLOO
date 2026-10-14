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
  const pool = new pg.Pool({ connectionString, max: 5 });
  const toPg = (sql) => { let i = 0; return sql.replace(/\?/g, () => `$${++i}`); };
  return {
    dialect: "postgres",
    exec: async (sql) => { await pool.query(sql); },
    query: async (sql, params = []) => (await pool.query(toPg(sql), params)).rows,
    close: () => pool.end(),
  };
}
