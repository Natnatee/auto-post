import { database } from "./cloud-db.mjs";
const ownerEmail = process.argv[process.argv.indexOf("--owner-email") + 1];
if (!process.argv.includes("--owner-email") || !ownerEmail?.includes("@")) throw new Error("Provide --owner-email for the existing personal workspace owner");
const db = database();
process.loadEnvFile(".env.facebook");
const pageId = process.env.FACEBOOK_PAGE_ID;
const pageName = process.env.FACEBOOK_PAGE_NAME;
if (!pageId || !/^\d+$/.test(pageId) || !pageName) throw new Error("Facebook Page configuration missing");
try {
  await db.connect();
  const workspace = await db.query("select w.id from public.workspaces w join auth.users u on u.id=w.owner_id join public.app_owners o on o.user_id=u.id where lower(u.email)=lower($1) and u.email_confirmed_at is not null", [ownerEmail]);
  if (workspace.rowCount !== 1) throw new Error("Expected one verified owner personal workspace");
  await db.query("insert into public.facebook_destinations(workspace_id,page_id,page_name,enabled,live_enabled) values($1,$2,$3,true,false) on conflict(workspace_id) do update set page_id=excluded.page_id,page_name=excluded.page_name,enabled=true,live_enabled=false", [workspace.rows[0].id, pageId, pageName]);
  console.log(`Destination configured: ${pageName}; simulation available; live remains DISABLED.`);
} catch (error) { console.error("Destination configuration failed:", error.message); process.exitCode = 1; }
finally { await db.end(); }
