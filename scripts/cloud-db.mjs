import { readFileSync } from "node:fs";
import pg from "pg";
export function adminEnv() {
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Use Node.js 22+: pnpm dlx node@22 <script>");
  process.loadEnvFile(".env.admin");
  const url = process.env.SUPABASE_URL;
  if (!url || !process.env.SUPABASE_DB_PASSWORD || !process.env.SUPABASE_SECRET_KEY) throw new Error("Missing .env.admin configuration");
  if (new URL(url).hostname !== "xnfoeyadgtzkotdcjzpa.supabase.co") throw new Error("Unexpected project; refusing administrative operation");
  return { url, key: process.env.SUPABASE_SECRET_KEY };
}
export function database() {
  adminEnv();
  return new pg.Client({
    host: "db.xnfoeyadgtzkotdcjzpa.supabase.co", port: 5432, user: "postgres", database: "postgres",
    password: process.env.SUPABASE_DB_PASSWORD,
    ssl: { rejectUnauthorized: true, ca: readFileSync("supabase/certs/prod-ca-2021.crt", "utf8") },
    connectionTimeoutMillis: 30000, statement_timeout: 30000,
  });
}
