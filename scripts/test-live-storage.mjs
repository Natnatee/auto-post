import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";
import { adminEnv, database } from "./cloud-db.mjs";

const { url, key } = adminEnv();
process.loadEnvFile(".env");
const publicKey = process.env.SUPABASE_PUBLISHABLE_KEY;
const options = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(url, key, options);
const db = database();
const users = [];
const origin = "http://127.0.0.1:3110";
let child; let browser; let directory; let failure; let cleanupFailure;
const check = (result, label) => { if (result.error) throw new Error(`${label} failed: ${result.error.code || result.error.status || "request error"}`); return result.data; };
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
try {
  await db.connect();
  directory = await mkdtemp(join(tmpdir(), "auto-post-storage-"));
  const imagePath = join(directory, "cover.png");
  const galleryPath = join(directory, "gallery.png");
  const videoPath = join(directory, "video.mp4");
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1cAAAAASUVORK5CYII=", "base64");
  await writeFile(imagePath, png); await writeFile(galleryPath, png);
  const ffmpeg = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "color=c=blue:s=160x90:d=1", "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", videoPath], { timeout: 15000, windowsHide: true });
  assert.equal(ffmpeg.status, 0, "ffmpeg must generate a real test MP4");
  for (let i = 0; i < 2; i++) {
    const email = `storage-test-${randomUUID()}@example.invalid`;
    const password = randomBytes(32).toString("base64url") + "Aa1!";
    const result = check(await admin.auth.admin.createUser({ email, password, email_confirm: true }), "create temporary test account");
    users.push({ id: result.user.id, email, password });
    await db.query("insert into public.app_owners(user_id) values($1)", [result.user.id]);
  }
  const serverEnv = { ...process.env, APP_ORIGIN: origin, NEXT_TELEMETRY_DISABLED: "1" };
  for (const name of ["SUPABASE_SECRET_KEY", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_DB_PASSWORD", "DATABASE_URL"]) delete serverEnv[name];
  child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3110"], { env: serverEnv, stdio: ["ignore", "pipe", "pipe"] });
  let logs = ""; child.stdout.on("data", data => { logs += data; }); child.stderr.on("data", data => { logs += data; });
  let ready = false;
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) throw new Error("Test server exited unexpectedly");
    try { ready = (await fetch(origin + "/api/dashboard")).ok; } catch {}
    if (ready) break;
    await delay(500);
  }
  assert.ok(ready, "Test server startup");
  browser = await chromium.launch({ channel: process.env.PLAYWRIGHT_CHANNEL || "msedge", headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  let tusRequests = 0; let apiFilePayload = false;
    page.on("response", async response => {
      if (response.status() >= 400) {
        const target = new URL(response.url());
        console.log("HTTP diagnostic:", response.status(), target.hostname, target.pathname);
        const raw = await response.text();
                let body = {}; try { body = JSON.parse(raw); } catch { body = { message: raw.slice(0, 400) }; }
              const detail = String(body.message || body.error || body.code || "request rejected").replace(/eyJ[A-Za-z0-9_.-]+/g, "[redacted-token]").replace(/sb_(secret|publishable)_[A-Za-z0-9_-]+/g, "[redacted-key]");
              console.log("Response diagnostic:", detail.slice(0, 300));
      }
    });
    page.on("requestfailed", request => { const target = new URL(request.url()); console.log("Network diagnostic:", target.hostname, target.pathname, request.failure()?.errorText); });
  page.on("request", request => {
    if (request.url().includes("/storage/v1/upload/resumable")) tusRequests++;
    if (request.url().startsWith(origin + "/api/") && request.method() === "POST" && (request.headers()["content-type"]?.startsWith("multipart/") || (request.postDataBuffer()?.length || 0) > 65536)) apiFilePayload = true;
  });
  await page.goto(origin);
  await page.getByLabel("อีเมล", { exact: true }).fill(users[0].email);
  await page.getByLabel("รหัสผ่าน", { exact: true }).fill(users[0].password);
  await page.getByRole("button", { name: "เข้าสู่ระบบ", exact: true }).click();
  await page.getByRole("button", { name: "บันทึก", exact: true }).waitFor();
  console.log("PASS: real Auth login and owner allowlist");
  assert.equal(new URL(page.url()).pathname, "/");
  for (const [label, file] of [["อัปโหลดวิดีโอ", videoPath], ["อัปโหลดปก", imagePath], ["อัปโหลดรูปภาพ", galleryPath]]) {
    await page.getByLabel(label, { exact: true }).setInputFiles(file);
    await page.locator(".library-filename").filter({ hasText: file.split(/[\\/]/).pop() }).waitFor({ timeout: 45000 });
    await page.getByRole("button", { name: "บันทึก", exact: true }).waitFor();
  }
  assert.equal(tusRequests, 0, "File selection must not start a video upload");
  assert.equal((await db.query("select count(*)::int as total from public.media where owner_id=$1", [users[0].id])).rows[0].total, 0, "File selection must not create upload metadata");
  console.log("PASS: selecting video, cover and gallery stages files locally with zero cloud writes");
  const title = `Storage test ${randomUUID()}`;
  await page.getByLabel("ชื่อโปรเจกต์", { exact: true }).fill(title);
  await page.getByLabel("แท็ก", { exact: true }).fill("storage test");
    await page.getByRole("button", { name: "เพิ่มแท็ก", exact: true }).click();
    await page.getByLabel("ราคา (บาท)", { exact: true }).fill("199.90");
  await page.getByLabel("คำอธิบาย", { exact: true }).fill("Temporary integration test; removed on completion");
  await page.getByRole("button", { name: "บันทึก", exact: true }).click();
  await page.getByRole("heading", { name: title, exact: true }).waitFor({ timeout: 60000 });
    assert.ok(tusRequests > 0, "Video must use actual resumable storage endpoint after Save");
    assert.equal(apiFilePayload, false, "File bytes must never pass through web API");
    console.log("PASS: Save uploads PNG/MP4 directly; video uses TUS; API receives metadata only");
  const result = await db.query("select cp.id,cp.price,pm.role,m.id as media_id,m.object_path,m.filename,m.status from public.content_projects cp join public.content_project_media pm on pm.project_id=cp.id join public.media m on m.id=pm.media_id where cp.created_by=$1", [users[0].id]);
  assert.equal(result.rows.length, 3);
    assert.equal(Number(result.rows[0].price), 199.9);
  assert.deepEqual(result.rows.map(row => row.role).sort(), ["cover", "gallery", "video"]);
  assert.ok(result.rows.every(row => row.status === "ready"));
  const files = { "cover.png": png, "gallery.png": png, "video.mp4": await readFile(videoPath) };
  for (const row of result.rows) {
    const signed = await page.evaluate(async id => {
      const response = await fetch(`/api/media/${id}/url`);
      if (!response.ok) throw new Error("Owner preview request rejected");
      return response.json();
    }, row.media_id);
    const downloaded = await fetch(signed.url);
    assert.equal(downloaded.status, 200);
    assert.equal(hash(Buffer.from(await downloaded.arrayBuffer())), hash(files[row.filename]), "Stored bytes must match originals");
  }
  const edited = await page.evaluate(async project => {
    const response = await fetch("/api/projects", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(project) });
    return response.status;
  }, { projectId: result.rows[0].id, title: title + " updated", description: "Updated metadata", hashtags: ["updated"], price: 0, assets: result.rows.map(row => ({ media_id: row.media_id, role: row.role, position: 0 })) });
  assert.equal(edited, 200);
    assert.equal(Number((await db.query("select price from public.content_projects where id=$1", [result.rows[0].id])).rows[0].price), 0);
  assert.equal((await db.query("select count(*)::int as total from public.posts where owner_id=$1", [users[0].id])).rows[0].total, 0);
  console.log("PASS: save/edit content with video, cover and gallery; byte-for-byte downloads; no publish jobs created");
  const other = createClient(url, publicKey, options);
  check(await other.auth.signInWithPassword({ email: users[1].email, password: users[1].password }), "other owner login");
  assert.equal(check(await other.from("content_projects").select("id"), "other owner project query").length, 0);
  assert.equal(check(await other.from("media").select("id"), "other owner media query").length, 0);
  const unauthorized = await other.storage.from("social-media").createSignedUrl(result.rows[0].object_path, 120);
  assert.ok(unauthorized.error, "Another owner must not mint a read URL");
  const anonymous = createClient(url, publicKey, options);
  assert.ok((await anonymous.storage.from("social-media").download(result.rows[0].object_path)).error, "Anonymous download must be denied");
  assert.ok((await other.rpc("save_content_project", { p_title: "forbidden", p_description: "", p_hashtags: [], p_workspace_id: (await db.query("select workspace_id from public.content_projects where id=$1", [result.rows[0].id])).rows[0].workspace_id, p_assets: [] })).error);
  console.log("PASS: anonymous and cross-owner access denied for storage and projects");
} catch (error) {
  failure = error;
  console.error("Live storage test failed:", error.message);
} finally {
  await browser?.close().catch(() => {});
  if (child) { child.kill("SIGTERM"); await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(5000)]); if (child.exitCode === null) child.kill("SIGKILL"); }
  try {
    for (const user of users) {
      const media = await db.query("select object_path from public.media where owner_id=$1", [user.id]);
      if (media.rows.length) check(await admin.storage.from("social-media").remove(media.rows.map(row => row.object_path)), "test storage cleanup");
      await db.query("delete from public.content_projects where created_by=$1", [user.id]);
      await db.query("delete from public.workspaces where owner_id=$1", [user.id]);
      await db.query("delete from public.posts where owner_id=$1", [user.id]);
      await db.query("delete from public.media where owner_id=$1", [user.id]);
      await db.query("delete from public.app_owners where user_id=$1", [user.id]);
      check(await admin.auth.admin.deleteUser(user.id), "temporary test account cleanup");
    }
    console.log("CLEANUP: temporary accounts, files, projects and workspaces removed");
  } catch (error) { cleanupFailure = error; console.error("Cleanup needs attention:", error.message); }
  await db.end().catch(() => {});
  if (directory) await rm(directory, { recursive: true, force: true });
}
if (failure || cleanupFailure) process.exitCode = 1;
