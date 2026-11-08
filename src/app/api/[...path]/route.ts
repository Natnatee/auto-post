import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { ZodError, z } from "zod";
import { contentProjectSchema, extensions, loginSchema, postSchema, uploadSchema } from "@/lib/validation";
import { assertOrigin, HttpError, readJson } from "@/lib/http";
import { submitProject } from "@/lib/publishing";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
type Context = { params: Promise<{ path: string[] }> };

async function handle(request: NextRequest, context: Context) {
  const pending: { name: string; value: string; options: CookieOptions }[] = [];
  const respond = (body: unknown, status = 200) => {
    const response = NextResponse.json(body, { status, headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } });
    for (const c of pending) response.cookies.set(c.name, c.value, c.options);
    return response;
  };
  try {
    const path = (await context.params).path.join("/");
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_PUBLISHABLE_KEY;
    const simulation = process.env.WORKER_MODE !== "live";
    if (request.method === "POST") assertOrigin(request, process.env.APP_ORIGIN || "http://localhost:3000");
    if (!url || !key) {
      if (request.method === "GET" && path === "dashboard") return respond({ configured: false, authenticated: false, owner: false, demo: true, simulation: true });
      throw new HttpError(503, "ยังไม่ได้ตั้งค่า Supabase ดู README.md");
    }
    const client = createServerClient(url, key, {
      cookies: { getAll: () => request.cookies.getAll(), setAll: values => { pending.push(...values); } },
      cookieOptions: { sameSite: "lax", httpOnly: true, secure: process.env.NODE_ENV === "production" || new URL(process.env.APP_ORIGIN || "http://localhost:3000").protocol === "https:" },
    });
    if (request.method === "POST" && path === "auth/logout") {
      const { error } = await client.auth.signOut();
      if (error) throw new HttpError(502, "ออกจากระบบไม่สำเร็จ");
      return respond({ ok: true });
    }
    if (request.method === "POST" && path === "auth/login") {
      const body = loginSchema.parse(await readJson(request));
      const { data, error } = await client.auth.signInWithPassword(body);
      if (error || !data.user) throw new HttpError(401, "อีเมลหรือรหัสผ่านไม่ถูกต้อง หรือยังไม่ยืนยันอีเมล");
      const owner = await client.from("app_owners").select("user_id").eq("user_id", data.user.id).maybeSingle();
      if (owner.error) { await client.auth.signOut(); throw new HttpError(503, "ยังไม่ได้ติดตั้ง schema หรือฐานข้อมูลไม่พร้อม"); }
      if (!owner.data) { await client.auth.signOut(); throw new HttpError(403, "บัญชีนี้ไม่ใช่เจ้าของ workspace"); }
      return respond({ ok: true });
    }
    const { data: { user } } = await client.auth.getUser();
    if (!user) {
      if (path === "dashboard" && request.method === "GET") return respond({ configured: true, authenticated: false, owner: false, simulation });
      throw new HttpError(401, "กรุณาเข้าสู่ระบบ");
    }
    const ownerResult = await client.from("app_owners").select("user_id").eq("user_id", user.id).maybeSingle();
    if (ownerResult.error) throw new HttpError(503, "ฐานข้อมูลไม่พร้อม ตรวจ migration และ app_owners");
    if (!ownerResult.data) {
      if (path === "dashboard" && request.method === "GET") return respond({ configured: true, authenticated: true, owner: false, simulation });
      throw new HttpError(403, "เฉพาะเจ้าของระบบเท่านั้น");
    }
    if (path === "dashboard" && request.method === "GET") {
      const [posts, media] = await Promise.all([
        client.from("posts").select("id,title,description,hashtags,scheduled_at,status,created_at,targets:post_targets(id,platform,status,error,published_url)").order("created_at", { ascending: false }).limit(100),
        client.from("media").select("id,filename,mime_type,size_bytes,status,created_at").order("created_at", { ascending: false }).limit(100),
      ]);
      if (posts.error || media.error) throw new HttpError(502, "โหลดคิวหรือคลังสื่อไม่สำเร็จ");
      return respond({ configured: true, authenticated: true, owner: true, simulation, posts: posts.data, media: media.data });
    }
    const publishingStatus = /^projects\/([^/]+)\/publishing$/.exec(path);
        if (request.method === "GET" && publishingStatus) {
          const projectId = z.uuid().parse(publishingStatus[1]);
          const project = await client.from("content_projects").select("workspace_id").eq("id", projectId).maybeSingle();
          if (project.error) throw new HttpError(502, "โหลดโปรเจกต์ไม่สำเร็จ");
          if (!project.data) throw new HttpError(404, "ไม่พบโปรเจกต์หรือไม่มีสิทธิ์");
          const [result, destination, ytDest, ttDest, xDest] = await Promise.all([
            client.from("posts").select("id,status,scheduled_at,execution_mode,created_at,targets:post_targets(id,platform,status,error,published_url,external_post_id,delivery_uncertain)").eq("project_id", projectId).order("created_at", { ascending: false }).limit(100),
            client.from("facebook_destinations").select("page_id,page_name,enabled,live_enabled").eq("workspace_id", project.data.workspace_id).maybeSingle(),
            client.from("youtube_destinations").select("channel_id,channel_title,enabled,live_enabled").eq("workspace_id", project.data.workspace_id).maybeSingle(),
            client.from("tiktok_destinations").select("creator_username,enabled,live_enabled").eq("workspace_id", project.data.workspace_id).maybeSingle(),
            client.from("x_destinations").select("screen_name,enabled,live_enabled").eq("workspace_id", project.data.workspace_id).maybeSingle(),
          ]);
          if (result.error) throw new HttpError(502, "โหลดสถานะเผยแพร่ไม่สำเร็จ");
          return respond({
            jobs: result.data,
            destination: destination.data,
            destinations: {
              facebook: destination.data,
              youtube: ytDest.data,
              tiktok: ttDest.data,
              x: xDest.data,
            },
            liveEnabled: process.env.FACEBOOK_LIVE_ENABLED === "true"
          });
        }
        if (request.method === "GET" && path === "projects") {
          const result = await client.from("content_projects").select("id,workspace_id,title,description,hashtags,price,created_at,updated_at,assets:content_project_media(media_id,role,position,media:media(id,filename,mime_type,size_bytes,status))").order("updated_at", { ascending: false }).limit(100);
          if (result.error) throw new HttpError(502, "โหลดโปรเจกต์ไม่สำเร็จ");
          return respond({ projects: result.data });
        }
        const preview = /^media\/([^/]+)\/url$/.exec(path);
        if (request.method === "GET" && preview) {
          const id = z.uuid().parse(preview[1]);
          const media = await client.from("media").select("object_path,status").eq("id", id).eq("owner_id", user.id).maybeSingle();
          if (media.error || !media.data || media.data.status !== "ready") throw new HttpError(404, "ไม่พบสื่อ");
          const result = await client.storage.from("social-media").createSignedUrl(media.data.object_path, 120);
          if (result.error) throw new HttpError(502, "เปิดสื่อไม่สำเร็จ");
          return respond({ url: result.data.signedUrl, expiresIn: 120 });
        }
        if (request.method !== "POST") throw new HttpError(404, "ไม่พบ API");
    const body = await readJson(request);
    const publish = /^projects\/([^/]+)\/publish$/.exec(path);
    if (publish) {
      const result = await submitProject(publish[1], body, process.env.FACEBOOK_LIVE_ENABLED === "true", args => client.rpc(args.p_expected_updated_at ? "submit_content_project_checked" : "submit_content_project", args));
      // Trigger Cloudflare Worker immediately in background so it processes immediately without waiting for cron
      const cfWorkerUrl = process.env.CLOUDFLARE_WORKER_URL || "https://auto-post-worker.drawnewtrio.workers.dev/run";
      fetch(cfWorkerUrl, { method: "POST", signal: AbortSignal.timeout(15000) }).catch(() => {});
      return respond(result, 202);
    }
    if (path === "projects") {
          const input = contentProjectSchema.parse(body);
          let workspaceId = input.workspaceId;
          if (!workspaceId) {
            const workspace = await client.rpc("ensure_personal_workspace");
            if (workspace.error || !workspace.data) throw new HttpError(502, "เปิด workspace ไม่สำเร็จ");
            workspaceId = workspace.data as string;
          }
          const result = await client.rpc("save_content_project", { p_title: input.title, p_description: input.description, p_hashtags: input.hashtags, p_workspace_id: workspaceId, p_assets: input.assets, p_project_id: input.projectId || null, p_price: input.price });
          if (result.error) throw new HttpError(400, "บันทึกโปรเจกต์ไม่สำเร็จ: ตรวจสิทธิ์ สื่อ และบทบาทไฟล์");
          return respond({ id: result.data, workspaceId, published: false }, input.projectId ? 200 : 201);
        }
        if (path === "uploads") {
      const input = uploadSchema.parse(body);
      const id = randomUUID();
      const objectPath = `${user.id}/${id}.${extensions[input.mimeType]}`;
      const inserted = await client.from("media").insert({ id, owner_id: user.id, filename: input.filename, object_path: objectPath, mime_type: input.mimeType, size_bytes: input.sizeBytes });
      if (inserted.error) throw new HttpError(502, "สร้างรายการอัปโหลดไม่สำเร็จ");
      const signed = await client.storage.from("social-media").createSignedUploadUrl(objectPath, { upsert: false });
      if (signed.error) throw new HttpError(502, "สร้าง signed upload URL ไม่สำเร็จ ตรวจ storage policy");
      const session = await client.auth.getSession();
            if (session.error || !session.data.session) throw new HttpError(401, "กรุณาเข้าสู่ระบบใหม่ก่อนอัปโหลด");
            return respond({ mediaId: id, bucket: "social-media", path: objectPath, token: signed.data.token, uploadAccessToken: session.data.session.access_token, uploadUrl: signed.data.signedUrl, supabaseUrl: url, publishableKey: key }, 201);
    }
    const complete = /^uploads\/([^/]+)\/complete$/.exec(path);
    if (complete) {
      const id = z.uuid().parse(complete[1]);
      const result = await client.rpc("complete_media", { p_media_id: id });
      if (result.error) throw new HttpError(400, "ตรวจไฟล์ไม่ผ่าน: ตรวจว่าการอัปโหลดเสร็จและขนาด/MIME ตรงกัน");
      return respond({ ok: true, media: result.data });
    }
    if (path === "posts") {
      const input = postSchema.parse(body);
      if (input.scheduledAt && Date.parse(input.scheduledAt) <= Date.now()) throw new HttpError(400, "กรุณาเลือกเวลาในอนาคต หรือเข้าคิวทันที");
      const result = await client.rpc("create_post", { p_title: input.title, p_description: input.description, p_hashtags: input.hashtags, p_platforms: input.platforms, p_media_ids: input.mediaIds, p_scheduled_at: input.scheduledAt || new Date().toISOString() });
      if (result.error) throw new HttpError(400, "สร้างงานไม่สำเร็จ: เลือกสื่อที่อัปโหลดเสร็จแล้ว 1–10 ไฟล์");
      return respond({ id: result.data, simulation }, 201);
    }
    const retry = /^targets\/([^/]+)\/retry$/.exec(path);
    if (retry) {
      const result = await client.rpc("retry_target", { p_target_id: z.uuid().parse(retry[1]) });
      if (result.error) throw new HttpError(400, "Retry ได้เฉพาะงานที่ failed หรือ blocked ของคุณเท่านั้น");
      return respond({ ok: true });
    }
    throw new HttpError(404, "ไม่พบ API");
  } catch (error) {
    if (error instanceof HttpError) return respond({ error: error.message }, error.status);
    if (error instanceof ZodError) return respond({ error: "ข้อมูลไม่ถูกต้อง: ตรวจ title, hashtag, สื่อ และเวลาที่เลือก" }, 400);
    console.error("API request failed; check server configuration and connectivity");
    return respond({ error: "ระบบขัดข้อง กรุณาลองใหม่" }, 500);
  }
}
export const GET = handle;
export const POST = handle;
