import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { readFileSync } from "node:fs";
process.loadEnvFile(".env.admin");
const url = process.env.SUPABASE_URL;
const client = createClient(url, process.env.SUPABASE_SECRET_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const buckets = await client.storage.listBuckets();
console.log("Storage:", buckets.error ? buckets.error.message : `OK (${buckets.data.length} buckets)`);
const users = await client.auth.admin.listUsers({ page: 1, perPage: 10 });
console.log("Auth admin:", users.error ? users.error.message : `OK (${users.data.users.length} users on first page)`);
const tables = await client.from("app_owners").select("user_id", { count: "exact", head: true });
console.log("App schema:", tables.error ? tables.error.message : `OK (${tables.count} owners)`);
const ref = new URL(url).hostname.split(".")[0];
const db = new pg.Client({ host: `db.${ref}.supabase.co`, port: 5432, user: "postgres", database: "postgres", password: process.env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: true, ca: readFileSync("supabase/certs/prod-ca-2021.crt", "utf8") }, connectionTimeoutMillis: 10000 });
try {
  await db.connect();
  const result = await db.query("select tablename from pg_tables where schemaname = current_schema()");
  console.log("Postgres:", `OK (${result.rows.length} public tables)`);
} catch (error) {
  console.log("Postgres:", error.code || "FAILED", error.message.replaceAll(process.env.SUPABASE_DB_PASSWORD || "<unset>", "[redacted]"));
  process.exitCode = 1;
} finally { await db.end().catch(() => {}); }
