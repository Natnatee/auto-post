import { readdir, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { database } from "./cloud-db.mjs";
if (!process.argv.includes("--apply")) throw new Error("Explicit --apply required; this changes the configured auto-post database");
const db = database();
try {
  await db.connect();
  await db.query("select pg_advisory_lock(hashtext('auto-post-migrations'))");
  await db.query("create table if not exists public._app_migrations(name text primary key, sha256 text not null, applied_at timestamptz not null default now())");
  await db.query("alter table public._app_migrations enable row level security; revoke all on public._app_migrations from anon, authenticated");
  for (const name of (await readdir("supabase/migrations")).filter(x => x.endsWith(".sql")).sort()) {
    const sql = await readFile(`supabase/migrations/${name}`, "utf8");
    const hash = createHash("sha256").update(sql).digest("hex");
    const existing = await db.query("select sha256 from public._app_migrations where name=$1", [name]);
    if (existing.rowCount) {
      if (existing.rows[0].sha256 !== hash) throw new Error(`Applied migration changed: ${name}`);
      console.log("Already applied:", name); continue;
    }
    const body = sql.replace(/^\s*begin\s*;/i, "").replace(/commit\s*;\s*$/i, "");
    await db.query("begin");
    try {
      await db.query(body);
      await db.query("insert into public._app_migrations(name,sha256) values($1,$2)", [name, hash]);
      await db.query("commit");
      console.log("Applied:", name);
    } catch (error) { await db.query("rollback"); throw error; }
  }
  await db.query("notify pgrst, 'reload schema'");
} catch (error) {
  console.error("Migration failed:", error.message); process.exitCode = 1;
} finally { await db.end(); }
