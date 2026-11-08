// Explicit admin-only one-shot publication. Idempotency key must be reused after any interruption.
import { spawn } from "node:child_process";
import { database, adminEnv } from "./cloud-db.mjs";
const [projectId, submissionKey, confirmation] = process.argv.slice(2);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
if (!uuid.test(projectId || "") || !uuid.test(submissionKey || "") || confirmation !== "--confirm-live-elephant-maker") throw new Error("Project UUID, stable submission UUID and explicit confirmation required");
const { url, key } = adminEnv();
process.loadEnvFile(".env.facebook");
if (process.env.FACEBOOK_PAGE_ID !== "1182106911641987" || !process.env.FACEBOOK_PAGE_ACCESS_TOKEN) throw new Error("Expected Page credentials missing");
const db = database();
let connected = false;
let workspaceId;
let gateChanged = false;
try {
  await db.connect(); connected = true;
  await db.query("select pg_advisory_lock(681315, 1)");
  const project = (await db.query("select p.*,u.email from public.content_projects p join public.workspaces w on w.id=p.workspace_id join auth.users u on u.id=w.owner_id where p.id=$1", [projectId])).rows[0];
  if (!project || project.email !== "drawnewtrio@gmail.com") throw new Error("Approved owner/project mismatch");
  workspaceId = project.workspace_id;
  const existing = (await db.query("select p.id,t.status,t.external_post_id,t.published_url,t.delivery_uncertain from public.posts p join public.post_targets t on t.post_id=p.id where p.owner_id=$1 and p.submission_key=$2", [project.created_by, submissionKey])).rows;
  if (existing.length) {
    console.log(JSON.stringify({ existing, dispatched: false, note: "Existing submission retained; never automatically redispatched" }, null, 2));
  } else {
    const outstanding = (await db.query("select count(*)::int as n from public.post_targets where status in ('pending','processing')")).rows[0].n;
    if (outstanding) throw new Error("Queue is not empty; refusing global claim");
    const destination = (await db.query("select * from public.facebook_destinations where workspace_id=$1", [workspaceId])).rows[0];
    if (!destination?.enabled || destination.page_id !== "1182106911641987" || destination.live_enabled) throw new Error("Destination mismatch or live gate already open");
    await db.query("begin");
    try {
      await db.query("update public.facebook_destinations set live_enabled=true where workspace_id=$1", [workspaceId]);
      await db.query("select set_config('request.jwt.claim.sub',$1,true)", [project.created_by]);
      const jobId = (await db.query("select public.submit_content_project($1,$2,null,'live') as id", [projectId, submissionKey])).rows[0].id;
      await db.query("commit"); gateChanged = true;
      console.log(JSON.stringify({ jobId, submissionKey, project: project.title, destination: "Elephant-Maker", mode: "live" }));
      const target = (await db.query("select public.claim_target(300) as target")).rows[0].target;
      if (!target || target.post_id !== jobId) throw new Error("Claim mismatch; no dispatch performed");
      const env = {};
      for (const name of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "LOCALAPPDATA"]) if (process.env[name] !== undefined) env[name] = process.env[name];
      Object.assign(env, { SUPABASE_URL: url, SUPABASE_SECRET_KEY: key, WORKER_MODE: "live", FACEBOOK_LIVE_ENABLED: "true", FACEBOOK_PAGE_ACCESS_TOKEN: process.env.FACEBOOK_PAGE_ACCESS_TOKEN, FACEBOOK_PAGE_ID: "1182106911641987", FACEBOOK_GRAPH_VERSION: "v27.0", LEASE_SECONDS: "300", PYTHONNOUSERSITE: "1", PYTHONUNBUFFERED: "1" });
      const code = "import sys,json; from worker.main import Config,Worker; t=json.loads(sys.stdin.buffer.read().decode('utf-8')); w=Worker(Config.from_env()); r=w.process(t); ok=w.transport.rpc('finish_target',{'p_target_id':t['id'],'p_lease_token':t['lease_token'],'p_status':r.status,'p_error':r.error,'p_published_url':r.published_url,'p_external_post_id':r.external_post_id,'p_delivery_uncertain':r.delivery_uncertain}); print(json.dumps({'status':r.status,'error':r.error,'external_post_id':r.external_post_id,'published_url':r.published_url,'delivery_uncertain':r.delivery_uncertain,'finish_accepted':ok})); sys.exit(0 if ok and r.status=='published' else 1)";
      const child = spawn("python", ["-c", code], { env, stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
      const timer = setTimeout(() => child.kill(), 90000);
      let output = "";
      child.stdout.on("data", chunk => { if (output.length < 16384) output += chunk; });
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(target));
      const exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("close", resolve); }).finally(() => clearTimeout(timer));
      if (output) console.log(output.trim());
      if (exitCode !== 0) throw new Error("Publication not confirmed; inspect retained job, do not resubmit with a new key");
    } catch (error) {
      await db.query("rollback").catch(() => {});
      throw error;
    }
  }
} catch (error) {
  // Never print transport errors that might contain credentials or private URLs.
  const safe = ["Queue is not empty; refusing global claim", "Approved owner/project mismatch", "Destination mismatch or live gate already open", "Claim mismatch; no dispatch performed", "Publication not confirmed; inspect retained job, do not resubmit with a new key"];
  console.error(safe.includes(error.message) ? error.message : "One-shot operation failed; inspect retained job before any retry");
  process.exitCode = 1;
} finally {
  if (connected && gateChanged) {
    try { await db.query("update public.facebook_destinations set live_enabled=false where workspace_id=$1", [workspaceId]); console.log("Live destination gate closed"); }
    catch { console.error("CRITICAL: Failed to close live destination gate; close manually before running workers"); process.exitCode = 1; }
  }
  if (connected) await db.query("select pg_advisory_unlock(681315, 1)").catch(() => {});
  await db.end().catch(() => {});
}
