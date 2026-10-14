import { openSqlite } from "./sqlite.js";

// DATABASE_URL (hosted Postgres) when deployed online, a local SQLite file otherwise.
export async function openDb({ databaseUrl, dbFile }) {
  if (databaseUrl) {
    const { openPostgres } = await import("./postgres.js");
    return openPostgres(databaseUrl);
  }
  return openSqlite(dbFile);
}
