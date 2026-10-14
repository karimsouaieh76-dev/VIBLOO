import { test } from "node:test";
import assert from "node:assert/strict";
import { postgresConfig } from "../src/db/drivers.js";

test("configurazione SSL per Neon, Supabase e database locale", () => {
  const neon = "postgresql://u:p@ep-cool-1.eu-central-1.aws.neon.tech/neondb?sslmode=require";
  assert.deepEqual(postgresConfig(neon), { connectionString: neon });

  const supa = postgresConfig("postgresql://postgres.abc:pass@aws-0-eu-central-1.pooler.supabase.com:5432/postgres?sslmode=require");
  assert.deepEqual(supa.ssl, { rejectUnauthorized: false });
  assert.ok(!supa.connectionString.includes("sslmode"));

  assert.deepEqual(postgresConfig("postgresql://postgres:pass@db.abc.supabase.co:5432/postgres").ssl, { rejectUnauthorized: false });
  assert.equal(postgresConfig("postgres://postgres@localhost:5433/test").ssl, undefined);
});
