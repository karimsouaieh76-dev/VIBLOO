import { sqliteDriver, postgresDriver } from "./drivers.js";
import { createStore } from "./store.js";

// DATABASE_URL (hosted Postgres) when deployed online, a local SQLite file otherwise.
export async function openDb({ databaseUrl, dbFile }) {
  const driver = databaseUrl ? await postgresDriver(databaseUrl) : await sqliteDriver(dbFile);
  return createStore(driver);
}
