import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { adminEnv, database } from "./cloud-db.mjs";

// Run only after migration 006 and a production build have been applied by the parent.
const origin = "http://127.0.0.1:3112";
const { url, key } = adminEnv();
process.loadEnvFile(".env");
const boundedFetch = (input, init = {}) => fetch(input, { ...init, signal: AbortSignal.timeout(15000) });
const admin = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: boundedFetch },
});
const db = database();
let connected = false;
let userId;
let server;
let worker;
let browser;
let failed = false;
const check = (result, label) => {
  if (result.error) throw new Error(label);
  return result.data;
};
function launch(command, args, env) {
  const child = spawn(command, args, { env, stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
  child.finished = new Promise(resolve => {
    child.once("error", () => resolve({ error: true }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  return child;
}
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  if (!(await Promise.race([child.finished.then(() => true), delay(2000).then(() => false)]))) {
    child.kill("SIGKILL");
    assert.ok(await Promise.race([child.finished.then(() => true), delay(2000).then(() => false)]), "Child shutdown timed out");
  }
}
async function api(context, method, path, data, status, requestOrigin = origin) {
  const response = await context.request.fetch(origin + path, {
    method, data, headers: { Origin: requestOrigin }, timeout: 15000, maxRedirects: 0,
  });
  assert.equal(response.status(), status, `${method} ${path}: expected ${status}`);
  return response;
}
try {
  await db.connect();
  connected = true;
  assert.equal((await db.query("select to_regclass('public.facebook_destinations') is not null as ready")).rows[0].ready, true, "Parent must apply migration 006 first");
  const serverEnv = { ...process.env, SUPABASE_URL: url, APP_ORIGIN: origin, WORKER_MODE: "simulation", FACEBOOK_LIVE_ENABLED: "false", NEXT_TELEMETRY_DISABLED: "1" };
  for (const name of Object.keys(serverEnv)) {
    if (["SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_DB_PASSWORD", "DATABASE_URL"].includes(name) || (/FACEBOOK/i.test(name) && /TOKEN|SECRET/i.test(name))) delete serverEnv[name];
  }
  // Refuse to accidentally exercise another process already listening on the test port.
  let occupied = false;
  try { await fetch(origin + "/api/dashboard", { signal: AbortSignal.timeout(1000) }); occupied = true; } catch {}
  assert.equal(occupied, false, "Loopback port 3112 is already occupied");
  server = launch(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3112"], serverEnv);
  const deadline = Date.now() + 30000;
  let ready = false;
  while (Date.now() < deadline) {
    assert.equal(server.exitCode, null, "Next server exited before readiness");
    try {
      ready = (await fetch(origin + "/api/dashboard", { signal: AbortSignal.timeout(Math.min(1000, Math.max(1, deadline - Date.now()))) })).ok;
    } catch {}
    if (ready) break;
    await delay(200);
  }
  assert.ok(ready, "Next server readiness exceeded 30 seconds");
  browser = await chromium.launch({ channel: "msedge", headless: true, timeout: 30000 });
  const context = await browser.newContext();

  const email = `publishing-simulation-${randomUUID()}@example.invalid`;
  const password = randomBytes(32).toString("base64url") + "Aa1!";
  const created = check(await admin.auth.admin.createUser({ email, password, email_confirm: true }), "Temporary Auth user creation failed");
  userId = created.user.id;
  await db.query("insert into public.app_owners(user_id) values($1)", [userId]);
  await api(context, "POST", "/api/auth/login", { email, password }, 200);
  const cookies = (await context.cookies(origin)).filter(cookie => cookie.name.startsWith("sb-"));
  assert.ok(cookies.length > 0 && cookies.every(cookie => cookie.httpOnly), "Login must set HttpOnly Auth cookies");
  const content = { title: "Original", description: "Temporary text-only publishing simulation", hashtags: ["simulation"], price: 123.45, assets: [] };
  const project = await (await api(context, "POST", "/api/projects", content, 201)).json();
  assert.ok(project.id && project.workspaceId, "Project must return project and workspace IDs");
  assert.equal((await db.query("select count(*)::int as total from public.workspaces where id=$1 and owner_id=$2", [project.workspaceId, userId])).rows[0].total, 1);
  await db.query("insert into public.facebook_destinations(workspace_id,page_id,page_name,enabled,live_enabled) values($1,'1182106911641987','Elephant-Maker',true,false)", [project.workspaceId]);
  const publishPath = `/api/projects/${project.id}/publish`;
  const submission = { submissionKey: randomUUID(), mode: "simulation" };
  const job = await (await api(context, "POST", publishPath, submission, 202)).json();
  assert.ok(job.id, "Submission must return a job ID");
  const replay = await (await api(context, "POST", publishPath, submission, 202)).json();
  assert.equal(replay.id, job.id);
  assert.equal((await db.query("select count(*)::int as total from public.posts where owner_id=$1", [userId])).rows[0].total, 1);
  const publishing = await (await api(context, "GET", `/api/projects/${project.id}/publishing`, undefined, 200)).json();
  assert.equal(publishing.jobs.length, 1);
  assert.equal(publishing.jobs[0].id, job.id);
  await api(context, "POST", "/api/projects", { ...content, projectId: project.id, workspaceId: project.workspaceId, title: "Changed" }, 200);
  const snapshot = await db.query("select p.content_snapshot,c.title from public.posts p join public.content_projects c on c.id=p.project_id where p.id=$1 and p.owner_id=$2", [job.id, userId]);
  assert.equal(snapshot.rows[0].title, "Changed");
  assert.equal(snapshot.rows[0].content_snapshot.title, "Original");
  assert.equal(Number(snapshot.rows[0].content_snapshot.price), 123.45);
  await api(context, "POST", publishPath, { ...submission, mode: "live", confirmLive: true }, 403);
  const anonymous = await browser.newContext();
  try { await api(anonymous, "POST", publishPath, submission, 401); } finally { await anonymous.close(); }
  await api(context, "POST", publishPath, submission, 403, "https://wrong-origin.example.invalid");
  assert.equal((await db.query("select count(*)::int as total from public.media where owner_id=$1", [userId])).rows[0].total, 0);
  console.log("PASS: HttpOnly login, text-only project, one idempotent job, immutable snapshot, live/anonymous/origin gates; media count=0");

  // Use an allowlist: no Facebook token, database password or inherited Python startup hooks.
  const workerEnv = {};
  for (const name of ["PATH", "Path", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "HOME", "USERPROFILE", "LOCALAPPDATA", "VIRTUAL_ENV", "LANG"]) {
    if (process.env[name] !== undefined) workerEnv[name] = process.env[name];
  }
  Object.assign(workerEnv, { SUPABASE_URL: url, SUPABASE_SECRET_KEY: key, WORKER_MODE: "simulation", FACEBOOK_LIVE_ENABLED: "false", PYTHONUNBUFFERED: "1", PYTHONNOUSERSITE: "1" });
  const others = (await db.query("select count(*)::int as total from public.post_targets t join public.posts p on p.id=t.post_id where p.owner_id is distinct from $1::uuid and (t.status in ('pending','processing') or p.status in ('queued','processing'))", [userId])).rows[0].total;
  console.log(`QUEUE: other pending/processing targets=${others}`);
  if (others > 0) {
    console.log("SKIP: actual worker not started because other owners have queued work; no mocked completion");
  } else {
    worker = launch("python", ["-m", "worker.main", "--once"], workerEnv);
    const result = await Promise.race([worker.finished, delay(30000).then(() => ({ timeout: true }))]);
    assert.equal(result.timeout, undefined, "Worker exceeded 30 seconds");
    assert.equal(result.code, 0, "Python worker failed to exit successfully");
    const finished = await db.query("select p.status as job_status,t.platform,t.status,t.dispatch_started_at,t.external_post_id,t.published_url from public.posts p join public.post_targets t on t.post_id=p.id where p.id=$1 and p.owner_id=$2", [job.id, userId]);
    assert.equal(finished.rows.length, 1);
    const target = finished.rows[0];
    assert.equal(target.platform, "facebook");
    assert.equal(target.status, "simulated");
    assert.equal(target.dispatch_started_at, null);
    assert.equal(target.external_post_id, null);
    assert.equal(target.published_url, null);
    assert.equal(target.job_status, "completed");
    console.log("PASS: actual simulation worker; targets=1, simulated=1, completed jobs=1, dispatch/external ID/published URL all null");
  }
} catch {
  failed = true;
  // Never print SDK errors, child output, cookies, passwords or environment values.
  console.error("FAIL: publishing simulation assertion or integration operation failed");
} finally {
  for (const cleanup of [() => stop(worker), () => browser?.close(), () => stop(server)]) {
    try { await cleanup(); } catch { failed = true; console.error("FAIL: local process/browser cleanup"); }
  }
  if (userId) {
    let cleaned = connected;
    if (connected) {
      try {
        await db.query("begin");
        await db.query("delete from public.posts where owner_id=$1", [userId]);
        await db.query("delete from public.content_projects where created_by=$1", [userId]);
        await db.query("delete from public.facebook_destinations where workspace_id in (select id from public.workspaces where owner_id=$1)", [userId]);
        await db.query("delete from public.media where owner_id=$1", [userId]);
        await db.query("delete from public.workspaces where owner_id=$1", [userId]);
        await db.query("delete from public.app_owners where user_id=$1", [userId]);
        await db.query("commit");
      } catch {
        cleaned = false;
        await db.query("rollback").catch(() => {});
        failed = true;
        console.error("FAIL: temporary database rows cleanup; temporary Auth account retained to avoid orphaning data");
      }
    }
    if (cleaned) {
      try {
        check(await admin.auth.admin.deleteUser(userId), "Temporary Auth cleanup failed");
        console.log("CLEANUP: generated owner, jobs, projects, destinations and workspaces removed; Auth users removed=1");
      } catch { failed = true; console.error("FAIL: temporary Auth account cleanup"); }
    }
  }
  await db.end().catch(() => { failed = true; });
}
if (failed) process.exitCode = 1;
