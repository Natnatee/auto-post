"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { createClient } from "@supabase/supabase-js";
import { Upload } from "tus-js-client";
import ProjectPublishing from "./project-publishing";

type Media = { id: string; filename: string; mime_type: string; size_bytes: number; status: string };
type Role = "video" | "cover" | "gallery";
type Asset = { media_id: string; role: Role; position: number; media?: Media };
type Project = { id: string; workspace_id: string; title: string; description: string; hashtags: string[]; price?: number | null; updated_at: string; assets: Asset[] };
type Dashboard = { configured: boolean; authenticated: boolean; owner: boolean; demo?: boolean; media?: Media[] };
type Ticket = { mediaId: string; bucket: string; path: string; token: string; uploadAccessToken: string; supabaseUrl: string; publishableKey: string };
type PendingFile = { id: string; file: File; role: Role; mediaId?: string; ticket?: Ticket; uploaded?: boolean };
const fingerprint = (file: File) => JSON.stringify([file.name, file.size, file.lastModified]);
const roles: { role: Role; label: string }[] = [{ role: "video", label: "วิดีโอ" }, { role: "cover", label: "ปก" }, { role: "gallery", label: "รูปภาพ" }];
const types = ["image/jpeg", "image/png", "image/webp", "video/mp4", "video/webm", "video/quicktime"];
const parseTags = (value: string) => [...new Set(value.split(/[\s,]+/).map(tag => tag.replace(/^#+/, "")).filter(Boolean))];
async function api<T>(url: string, body?: unknown): Promise<T> {
  const response = await fetch(url, { method: body === undefined ? "GET" : "POST", cache: "no-store", headers: body === undefined ? undefined : { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) throw new Error("request failed");
  return response.json() as Promise<T>;
}
export const DEFAULT_MCU_TAGS = [
  "งานประดิษฐ์",
  "diy",
  "esp32",
  "arduino",
  "iot",
  "maker",
  "อิเล็กทรอนิกส์",
  "tiktokuni",
];

export const SUGGESTED_MCU_TAGS = [
  "งานประดิษฐ์",
  "diy",
  "esp32",
  "arduino",
  "iot",
  "maker",
  "อิเล็กทรอนิกส์",
  "tiktokuni",
  "robotics",
  "สิ่งประดิษฐ์",
  "สมองกลฝังตัว",
  "เทคโนโลยี",
  "โครงงาน",
];

export type TargetStatus = {
  id: string;
  platform: string;
  status: string;
  attempts?: number;
  error?: string | null;
  published_url?: string | null;
  external_post_id?: string | null;
  delivery_uncertain?: boolean;
  created_at: string;
};

export type PostStatus = {
  id: string;
  project_id?: string | null;
  title: string;
  description?: string;
  hashtags: string[];
  scheduled_at: string;
  status: string;
  execution_mode?: string;
  created_at: string;
  targets: TargetStatus[];
};

const PLATFORM_ICONS: Record<string, { label: string; icon: string; themeClass: string }> = {
  facebook: { label: "Facebook", icon: "📘", themeClass: "btn-platform-fb" },
  youtube: { label: "YouTube", icon: "▶️", themeClass: "btn-platform-yt" },
  tiktok: { label: "TikTok", icon: "🎵", themeClass: "btn-platform-tt" },
  x: { label: "X (Twitter)", icon: "🐦", themeClass: "btn-platform-x" },
};

function defaultTags() {
  try {
    const raw = localStorage.getItem("autopost.default-tags");
    if (raw) {
      const value: unknown = JSON.parse(raw);
      if (Array.isArray(value) && value.length <= 30 && value.every(tag => typeof tag === "string" && tag.length <= 100 && !/[\s,]/.test(tag))) {
        if (value.length === 1 && value[0] === "สร้างสรรค์") {
          return DEFAULT_MCU_TAGS;
        }
        return parseTags(value.join(" "));
      }
    }
  } catch {}
  return DEFAULT_MCU_TAGS;
}

function Spinner({ label }: { label: string }) {
  return <span className="loading-status" role="status" aria-label={label}><span className="spinner" aria-hidden="true" /></span>;
}

export function ContentLibrary({ view = "upload" }: { view?: "upload" | "projects" | "status" }) {
  const router = useRouter();
  const initializedEdit = useRef(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loggingOut, setLoggingOut] = useState(false);
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [projects, setProjects] = useState<Project[]>([]);
  const [media, setMedia] = useState<Media[]>([]);
  const [postStatuses, setPostStatuses] = useState<PostStatus[]>([]);
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "published" | "failed">("all");
  const [retryingTargets, setRetryingTargets] = useState<Set<string>>(new Set());

  const [editing, setEditing] = useState<Project | null>(null);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [tags, setTags] = useState<string[]>([]);
  const [tagInput, setTagInput] = useState("");
  const [price, setPrice] = useState("");
  const [assets, setAssets] = useState<Asset[]>([]);
  const [pending, setPending] = useState<PendingFile[]>([]);
  const fingerprints = useRef(new Map<string, string>());
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [preview, setPreview] = useState("");
  const lock = useRef(false);
  const activeUpload = useRef<Upload | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    setTags(defaultTags());
    void load();
    return () => { mounted.current = false; void activeUpload.current?.abort().catch(() => {}); };
  }, [view]);

  useEffect(() => {
    if (view !== "status" || !dashboard?.authenticated) return;
    const hasActive = postStatuses.some(
      p => ["queued", "processing"].includes(p.status) || p.targets?.some(t => ["pending", "processing"].includes(t.status))
    );
    if (!hasActive) return;
    const timer = setInterval(async () => {
      try {
        const data = await api<{ posts: PostStatus[] }>("/api/status");
        if (mounted.current) setPostStatuses(data.posts || []);
      } catch {}
    }, 4000);
    return () => clearInterval(timer);
  }, [view, dashboard?.authenticated, postStatuses]);

  async function load() {
    setLoading(true);
    try {
      const result = await api<Dashboard>("/api/dashboard");
      if (!mounted.current) return;
      setDashboard(result); setMedia(result.media || []);
      if (result.configured && result.authenticated && result.owner && !result.demo) {
        if (view === "status") {
          const data = await api<{ posts: PostStatus[] }>("/api/status");
          if (mounted.current) setPostStatuses(data.posts || []);
        } else {
          const data = await api<{ projects: Project[] }>("/api/projects");
          if (mounted.current) {
            setProjects(data.projects);
            if (view === "upload" && !initializedEdit.current) {
              initializedEdit.current = true;
              const id = new URLSearchParams(window.location.search).get("edit");
              const project = data.projects.find(item => item.id === id);
              if (project) {
                setEditing(project); setTitle(project.title); setDescription(project.description || "");
                setTags(project.hashtags); setPrice(project.price != null ? String(project.price) : ""); setAssets(project.assets);
              } else if (id) setError("ไม่พบโปรเจกต์");
            }
          }
        }
      }
    } catch { if (mounted.current) setError("โหลดไม่สำเร็จ"); }
    finally { if (mounted.current) setLoading(false); }
  }

  async function retryTarget(targetId: string) {
    if (retryingTargets.has(targetId) || !mounted.current) return;
    setRetryingTargets(prev => new Set(prev).add(targetId));
    setError("");
    setNotice("");
    try {
      await api(`/api/targets/${encodeURIComponent(targetId)}/retry`, {});
      if (mounted.current) setNotice("ส่งคำสั่งลองใหม่เรียบร้อยแล้ว");
      const data = await api<{ posts: PostStatus[] }>("/api/status");
      if (mounted.current) setPostStatuses(data.posts || []);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : "ลองใหม่ไม่สำเร็จ");
    } finally {
      if (mounted.current) {
        setRetryingTargets(prev => {
          const next = new Set(prev);
          next.delete(targetId);
          return next;
        });
      }
    }
  }
  async function authenticate(logout = false) {
    if (lock.current) return;
    lock.current = true; setBusy(true); setLoggingOut(logout); setError("");
    try {
      await api(logout ? "/api/auth/logout" : "/api/auth/login", logout ? {} : { email, password });
      setPassword("");
      if (logout) {
        reset(); setProjects([]); setMedia([]); initializedEdit.current = false;
        setDashboard(current => current ? { ...current, authenticated: false, owner: false } : null);
      } else await load();
    } catch { setError(logout ? "ออกจากระบบไม่สำเร็จ" : "เข้าสู่ระบบไม่สำเร็จ"); }
    finally { lock.current = false; setBusy(false); setLoggingOut(false); }
  }
  function reset() { setPending([]); fingerprints.current.clear(); setEditing(null); setTitle(""); setDescription(""); setTags(defaultTags()); setTagInput(""); setPrice(""); setAssets([]); setError(""); setNotice(""); }
  const authorized = !!dashboard?.configured && !!dashboard.authenticated && !!dashboard.owner && !dashboard.demo;
  const roleCount = (role: Role) => assets.filter(asset => asset.role === role).length + pending.filter(item => item.role === role).length;
  function attach(id: string, role: Role) {
    if (!id || lock.current || !authorized) return;
    if (assets.some(asset => asset.media_id === id && asset.role === role)) { setError("ไฟล์นี้ถูกเลือกแล้ว"); return; }
    if (roleCount(role) >= (role === "gallery" ? 10 : 1)) { setError("เลือกไฟล์ครบแล้ว"); return; }
    setAssets(current => [...current, { media_id: id, role, position: current.filter(asset => asset.role === role).length }]);
  }
  function stageFiles(files: File[], role: Role) {
    if (lock.current || !authorized || !files.length) return;
    if (files.length + roleCount(role) > (role === "gallery" ? 10 : 1)) { setError("จำนวนไฟล์เกินกำหนด"); return; }
    if (files.some(file => !types.includes(file.type) || !file.size || (role === "video" ? !file.type.startsWith("video/") : !file.type.startsWith("image/")))) { setError("ชนิดไฟล์ไม่รองรับ (รองรับ MP4, WebM, QuickTime, JPEG, PNG, WebP)"); return; }
    const oversized = files.find(file => file.size > 50 * 1024 * 1024);
    if (oversized) {
      const mb = (oversized.size / (1024 * 1024)).toFixed(1);
      setError(`⚠️ ไฟล์ "${oversized.name}" มีขนาด ${mb} MB ซึ่งเกินขีดจำกัด 50 MB ของ Supabase Free กรุณาบีบอัดไฟล์ก่อน`);
      return;
    }
    const selected = new Set([...pending.filter(item => item.role === role).map(item => fingerprint(item.file)), ...assets.filter(asset => asset.role === role).flatMap(asset => { const key = fingerprints.current.get(asset.media_id); return key ? [key] : []; })]);
    for (const file of files) {
      const key = fingerprint(file);
      if (selected.has(key)) { setError("มีไฟล์ซ้ำ"); return; }
      selected.add(key);
    }
    setPending(current => [...current, ...files.map(file => ({ id: crypto.randomUUID(), file, role }))]);
    setError(""); setNotice("");
  }
  function mergedTags() {
    const result = [...new Set([...tags, ...parseTags(tagInput)])];
    if (result.length > 30 || result.some(tag => tag.length > 100)) {
      setError("แท็กไม่เกิน 30 แท็ก แท็กละไม่เกิน 100 ตัวอักษร");
      return null;
    }
    return result;
  }
  function addTags() {
    const result = mergedTags();
    if (!result) return;
    setTags(result); setTagInput(""); setError("");
  }
  async function save() {
    if (lock.current || !authorized || !mounted.current) return;
    if (!title.trim() || title.trim().length > 500) { setError("กรอกชื่อโปรเจกต์ไม่เกิน 500 ตัวอักษร"); return; }
    const hashtags = mergedTags();
    if (!hashtags) return;
    const amount = price === "" ? null : Number(price);
    if (amount !== null && (!/^\d+(?:\.\d{1,2})?$/.test(price) || !Number.isFinite(amount) || amount < 0 || amount > 9999999999.99)) { setError("กรอกราคา 0–9,999,999,999.99 บาท ทศนิยมไม่เกิน 2 ตำแหน่ง"); return; }
    if (new Set(assets.map(asset => JSON.stringify([asset.media_id, asset.role]))).size !== assets.length) { setError("มีไฟล์ซ้ำ"); return; }
    if (roles.some(({ role }) => roleCount(role) > (role === "gallery" ? 10 : 1))) { setError("จำนวนไฟล์เกินกำหนด"); return; }
    const oversized = pending.find(item => item.file.size > 50 * 1024 * 1024);
    if (oversized) {
      const mb = (oversized.file.size / (1024 * 1024)).toFixed(1);
      setError(`⚠️ ไฟล์ "${oversized.file.name}" (${mb} MB) เกินขีดจำกัด 50 MB ของ Supabase Free กรุณานำออกหรือบีบอัดไฟล์ก่อน`);
      return;
    }
    lock.current = true; setBusy(true); setError(""); setNotice("");
    const completedAssets = [...assets];
    let uploading = true;
    const updatePending = (item: PendingFile) => {
      if (mounted.current) setPending(current => current.map(value => value.id === item.id ? { ...item } : value));
    };
    try {
      for (const original of pending) {
        if (!mounted.current) return;
        const item = { ...original };
        const { file, role } = item;
        const readyAsset = completedAssets.find(asset => asset.media?.status === "ready" && fingerprints.current.get(asset.media_id) === fingerprint(file));
        if (readyAsset) {
          completedAssets.push({ ...readyAsset, role, position: completedAssets.filter(asset => asset.role === role).length });
          setAssets([...completedAssets]);
          setPending(current => current.filter(value => value.id !== item.id));
          continue;
        }
        setProgress(0);
        if (!item.ticket) {
          item.ticket = await api<Ticket>("/api/uploads", { filename: file.name, mimeType: file.type, sizeBytes: file.size });
          item.mediaId = item.ticket.mediaId;
          updatePending(item);
        }
        if (!mounted.current) return;
        const ticket = item.ticket;
        if (!item.uploaded) {
        if (file.type.startsWith("video/") || file.size > 6 * 1024 ** 2) {
          const endpoint = new URL(ticket.supabaseUrl);
          if (endpoint.hostname.endsWith(".supabase.co") && !endpoint.hostname.endsWith(".storage.supabase.co")) endpoint.hostname = endpoint.hostname.replace(/\.supabase\.co$/, ".storage.supabase.co");
          endpoint.pathname = "/storage/v1/upload/resumable"; endpoint.search = ""; endpoint.hash = "";
          await new Promise<void>((resolve, reject) => {
            const task = new Upload(file, { endpoint: endpoint.toString(), headers: { apikey: ticket.publishableKey, authorization: `Bearer ${ticket.uploadAccessToken}`, "x-signature": ticket.token }, metadata: { bucketName: ticket.bucket, objectName: ticket.path, contentType: file.type, cacheControl: "3600" }, chunkSize: 6 * 1024 ** 2, uploadDataDuringCreation: true, removeFingerprintOnSuccess: true, retryDelays: [0, 1000, 3000, 5000], onProgress: (sent, total) => { if (mounted.current) setProgress(Math.round(sent / total * 100)); }, onError: reject, onSuccess: () => resolve() });
            activeUpload.current = task; task.start();
          });
        } else {
          const client = createClient(ticket.supabaseUrl, ticket.publishableKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
          const result = await client.storage.from(ticket.bucket).uploadToSignedUrl(ticket.path, ticket.token, file, { contentType: file.type });
          if (result.error) throw new Error("upload failed");
        }
          item.uploaded = true;
          updatePending(item);
        }
        if (!mounted.current) return;
        await api(`/api/uploads/${encodeURIComponent(ticket.mediaId)}/complete`, {});
        if (!mounted.current) return;
        const uploadedMedia: Media = { id: ticket.mediaId, filename: file.name, mime_type: file.type, size_bytes: file.size, status: "ready" };
        setMedia(current => [...current.filter(value => value.id !== ticket.mediaId), uploadedMedia]);
        fingerprints.current.set(ticket.mediaId, fingerprint(file));
        completedAssets.push({ media_id: ticket.mediaId, role, position: completedAssets.filter(asset => asset.role === role).length, media: uploadedMedia });
        setAssets([...completedAssets]);
        setPending(current => current.filter(value => value.id !== item.id));
      }
      if (!mounted.current) return;
      uploading = false;
      await api("/api/projects", { projectId: editing?.id, workspaceId: editing?.workspace_id, title: title.trim(), description, hashtags, price: amount, assets: completedAssets.map(({ media_id, role }, index, list) => ({ media_id, role, position: list.slice(0, index).filter(asset => asset.role === role).length })) });
      if (!mounted.current) return;
      router.push("/projects");
    } catch { if (mounted.current) setError(uploading ? "อัปโหลดไม่สำเร็จ กรุณาลองอีกครั้ง" : "บันทึกไม่สำเร็จ กรุณาลองอีกครั้ง"); }
    finally { activeUpload.current = null; lock.current = false; if (mounted.current) { setBusy(false); setProgress(null); } }
  }
  async function openAsset(id: string) {
    setPreview(id); setError("");
    const popup = window.open("about:blank", "_blank");
    if (popup) popup.opener = null;
    try {
      const { url } = await api<{ url: string; expiresIn: number }>(`/api/media/${encodeURIComponent(id)}/url`);
      const target = new URL(url);
      if (target.protocol !== "https:" && target.protocol !== "http:") throw new Error("invalid URL");
      if (popup) popup.location.replace(target.toString());
      else if (mounted.current) setError("กรุณาอนุญาตป๊อปอัปแล้วลองอีกครั้ง");
    } catch { popup?.close(); if (mounted.current) setError("เปิดไฟล์ไม่สำเร็จ"); }
    finally { if (mounted.current) setPreview(""); }
  }
  const filteredPosts = postStatuses.filter(post => {
    if (statusFilter === "all") return true;
    if (statusFilter === "active") {
      return (
        ["queued", "processing"].includes(post.status) ||
        post.targets?.some(t => ["pending", "processing"].includes(t.status))
      );
    }
    if (statusFilter === "published") {
      return post.targets?.some(t => ["published", "simulated"].includes(t.status));
    }
    if (statusFilter === "failed") {
      return (
        post.status === "failed" ||
        post.targets?.some(t => ["failed", "blocked"].includes(t.status) || t.delivery_uncertain)
      );
    }
    return true;
  });

  return <main className="workspace library-workspace">
    <header>
      <Link className="brand" href="/" onClick={() => { if (view === "upload" && !busy) reset(); }}>
        auto<span>post</span>
      </Link>
      <nav aria-label="เมนู">
        <Link href="/" onClick={() => { if (view === "upload" && !busy) reset(); }} aria-current={view === "upload" ? "page" : undefined}>
          อัปโหลด
        </Link>
        <Link href="/projects" aria-current={view === "projects" ? "page" : undefined}>
          โปรเจกต์
        </Link>
        <Link href="/status" aria-current={view === "status" ? "page" : undefined}>
          ติดตามสถานะ
        </Link>
      </nav>
      {dashboard?.authenticated && (
        <button className="logout" disabled={busy || loading} onClick={() => void authenticate(true)}>
          {loggingOut ? <Spinner label="กำลังออกจากระบบ" /> : "ออกจากระบบ"}
        </button>
      )}
    </header>
    <h1>{view === "upload" ? editing ? "แก้ไขโปรเจกต์" : "อัปโหลด" : view === "projects" ? "โปรเจกต์" : "ติดตามสถานะการเผยแพร่"}</h1>
    {error && <p className="error" role="alert">{error}</p>}
    {notice && <p className="success" role="status">{notice}</p>}
    {loading ? <Spinner label="กำลังโหลดข้อมูล" /> : !dashboard ? <button onClick={() => void load()}>ลองอีกครั้ง</button> : dashboard.configured && !dashboard.demo && !dashboard.authenticated ? <form className="login-form card" onSubmit={event => { event.preventDefault(); void authenticate(); }}><label>อีเมล<input type="email" autoComplete="username" required value={email} disabled={busy} onChange={event => setEmail(event.target.value)} /></label><label>รหัสผ่าน<input type="password" autoComplete="current-password" required value={password} disabled={busy} onChange={event => setPassword(event.target.value)} /></label><button className="primary" disabled={busy}>{busy ? <Spinner label="กำลังเข้าสู่ระบบ" /> : "เข้าสู่ระบบ"}</button></form> : dashboard.configured && !dashboard.demo && !dashboard.owner ? <p>ไม่มีสิทธิ์เข้าใช้งาน</p> : <>
      {(!dashboard.configured || dashboard.demo) && <span className="badge">DEMO</span>}
      {view === "upload" ? <form className="library-form" noValidate onSubmit={event => { event.preventDefault(); void save(); }}>
        {editing && <div className="row"><h2>แก้ไขโปรเจกต์</h2><button type="button" disabled={busy} onClick={reset}>เริ่มใหม่</button></div>}
        <fieldset disabled={busy || !authorized} className="library-fields">
          {roles.map(({ role, label }) => <fieldset className="library-attach" key={role}><legend>{label} ({roleCount(role)}/{role === "gallery" ? 10 : 1}) · สูงสุด 50 MB</legend>
            <input aria-label={`อัปโหลด${label}`} type="file" accept={role === "video" ? "video/mp4,video/webm,video/quicktime" : "image/jpeg,image/png,image/webp"} multiple={role === "gallery"} disabled={busy || roleCount(role) >= (role === "gallery" ? 10 : 1)} onChange={event => { const files = Array.from(event.target.files || []); event.target.value = ""; stageFiles(files, role); }} />
            <select aria-label={`เลือก${label}ที่มีอยู่`} value="" disabled={busy || roleCount(role) >= (role === "gallery" ? 10 : 1)} onChange={event => attach(event.target.value, role)}><option value="">เลือกไฟล์ที่มีอยู่</option>{media.filter(item => item.status === "ready" && item.mime_type.startsWith(role === "video" ? "video/" : "image/") && !assets.some(asset => asset.media_id === item.id && asset.role === role)).map(item => <option key={item.id} value={item.id}>{item.filename} ({(item.size_bytes / (1024 * 1024)).toFixed(1)} MB)</option>)}</select>
            {assets.filter(asset => asset.role === role).map(asset => <div className="row" key={`${asset.role}-${asset.media_id}`}><span className="library-filename">{media.find(item => item.id === asset.media_id)?.filename || asset.media?.filename || asset.media_id}</span><button type="button" aria-label={`นำ${asset.media?.filename || media.find(item => item.id === asset.media_id)?.filename || label}ออก`} onClick={() => setAssets(current => current.filter(item => item.media_id !== asset.media_id || item.role !== asset.role))}>×</button></div>)}
            {pending.filter(item => item.role === role).map(item => <div className="row" key={item.id}><span className="library-filename">{item.file.name} · {label} · {(item.file.size / (1024 * 1024)).toFixed(1)} MB · รอบันทึก</span><button type="button" disabled={busy} aria-label={`นำ${item.file.name}ออก`} onClick={() => setPending(current => current.filter(value => value.id !== item.id))}>×</button></div>)}
          </fieldset>)}
          <label>ชื่อโปรเจกต์<input required maxLength={500} value={title} onChange={event => setTitle(event.target.value)} /></label>
          <div className="library-tag-field">
            <label htmlFor="library-tag-input">แท็ก ({tags.length}/30)</label>
            <div className="library-tag-chips">
              {tags.map(tag => (
                <button key={tag} type="button" aria-label={`ลบแท็ก ${tag}`} onClick={() => setTags(current => current.filter(value => value !== tag))}>
                  #{tag} ×
                </button>
              ))}
            </div>
            <div className="library-tag-entry">
              <input
                id="library-tag-input"
                aria-label="แท็ก"
                placeholder="พิมพ์แท็กใหม่..."
                value={tagInput}
                onChange={event => setTagInput(event.target.value)}
                onKeyDown={event => {
                  if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    addTags();
                  }
                }}
              />
              <button type="button" aria-label="เพิ่มแท็ก" onClick={addTags}>
                +
              </button>
            </div>
            <div className="suggested-tags-wrapper">
              <span className="suggested-tags-title">💡 แท็กแนะนำยอดนิยมสำหรับ MCU / งานประดิษฐ์ (คลิกเพื่อเพิ่ม/ลบ):</span>
              <div className="suggested-tags-chips">
                {SUGGESTED_MCU_TAGS.map(sTag => {
                  const isSelected = tags.includes(sTag);
                  return (
                    <button
                      key={sTag}
                      type="button"
                      className={`suggested-tag-btn ${isSelected ? "selected" : ""}`}
                      onClick={() => {
                        if (isSelected) {
                          setTags(tags.filter(t => t !== sTag));
                        } else {
                          if (tags.length >= 30) {
                            setError("แท็กไม่เกิน 30 แท็ก");
                            return;
                          }
                          setTags([...tags, sTag]);
                        }
                      }}
                    >
                      {isSelected ? `✓ #${sTag}` : `+ #${sTag}`}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
          <label>ราคา (บาท)<input type="number" min="0" max="9999999999.99" step="0.01" inputMode="decimal" value={price} onChange={event => setPrice(event.target.value)} /></label>
          <label>คำอธิบาย<textarea rows={4} maxLength={5000} value={description} onChange={event => setDescription(event.target.value)} /></label>
        </fieldset>
        {progress !== null && <div role="status"><progress max={100} value={progress} aria-label="อัปโหลด" />{progress}%</div>}
        <button className="primary" type="submit" disabled={busy || !authorized}>{busy ? <Spinner label={progress !== null ? "กำลังอัปโหลด" : "กำลังบันทึก"} /> : "บันทึก"}</button>
      </form> : view === "projects" ? <section className="page-section" aria-label="โปรเจกต์">{projects.length === 0 ? <div className="empty-state"><p>ไม่มีโปรเจกต์</p><Link href="/">อัปโหลด</Link></div> : projects.map(project => <article className="card" key={project.id}><div className="row"><h2>{project.title}</h2><Link className="edit-link" href={`/?edit=${encodeURIComponent(project.id)}`}>แก้ไข</Link></div>{project.price != null && <p>{new Intl.NumberFormat("th-TH", { style: "currency", currency: "THB" }).format(project.price)}</p>}{project.description && <p className="post-description">{project.description}</p>}{project.hashtags.length > 0 && <p className="muted">{project.hashtags.map(tag => `#${tag}`).join(" ")}</p>}<div className="library-assets">{project.assets.map(asset => {
  const roleInfo = roles.find(item => item.role === asset.role);
  const isVideo = asset.role === "video" || asset.media?.mime_type === "video/mp4";
  const icon = isVideo ? "🎬" : asset.role === "cover" ? "🖼️" : "📷";
  return <button type="button" className={`asset-chip asset-chip-${asset.role}`} key={`${asset.role}-${asset.media_id}`} disabled={busy || !!preview} onClick={() => void openAsset(asset.media_id)}>
    {preview === asset.media_id ? <Spinner label="กำลังเปิดไฟล์" /> : (
      <span className="asset-chip-content">
        <span className="asset-badge" aria-hidden="true">{icon} {roleInfo?.label || asset.role}</span>
        <span className="asset-filename">{asset.media?.filename || "เปิดไฟล์"}</span>
        <span className="asset-arrow" aria-hidden="true">↗</span>
      </span>
    )}
  </button>;
})}</div><ProjectPublishing project={project} disabled={!authorized || busy} /></article>)}</section> : (
        <section className="page-section" aria-label="ติดตามสถานะ">
          <div className="status-header-row">
            <div>
              <p className="muted">ตรวจสอบผลการเผยแพร่โปรเจกต์ไปยังทุกช่องทางแบบเรียลไทม์</p>
            </div>
            <button type="button" className="refresh-btn" disabled={loading} onClick={() => void load()}>
              {loading ? <Spinner label="กำลังรีเฟรช" /> : "🔄 รีเฟรชข้อมูล"}
            </button>
          </div>

          <div className="status-filter-group" role="tablist" aria-label="ตัวกรองสถานะ">
            <button
              type="button"
              className={`status-filter-btn ${statusFilter === "all" ? "active" : ""}`}
              onClick={() => setStatusFilter("all")}
            >
              ทั้งหมด ({postStatuses.length})
            </button>
            <button
              type="button"
              className={`status-filter-btn ${statusFilter === "active" ? "active" : ""}`}
              onClick={() => setStatusFilter("active")}
            >
              ⏳ กำลังดำเนินการ ({postStatuses.filter(p => ["queued", "processing"].includes(p.status) || p.targets?.some(t => ["pending", "processing"].includes(t.status))).length})
            </button>
            <button
              type="button"
              className={`status-filter-btn ${statusFilter === "published" ? "active" : ""}`}
              onClick={() => setStatusFilter("published")}
            >
              ✅ เผยแพร่แล้ว ({postStatuses.filter(p => p.targets?.some(t => ["published", "simulated"].includes(t.status))).length})
            </button>
            <button
              type="button"
              className={`status-filter-btn ${statusFilter === "failed" ? "active" : ""}`}
              onClick={() => setStatusFilter("failed")}
            >
              ⚠️ มีปัญหา ({postStatuses.filter(p => p.status === "failed" || p.targets?.some(t => ["failed", "blocked"].includes(t.status) || t.delivery_uncertain)).length})
            </button>
          </div>

          {filteredPosts.length === 0 ? (
            <div className="empty-state">
              <p>{postStatuses.length === 0 ? "ยังไม่มีประวัติการเผยแพร่" : "ไม่พบรายการตามตัวกรองที่เลือก"}</p>
              <Link href="/projects">ไปที่หน้าโปรเจกต์</Link>
            </div>
          ) : (
            filteredPosts.map(post => {
              const hasPendingTarget = post.targets?.some(t => ["pending", "processing"].includes(t.status));
              const isLive = post.execution_mode === "live";
              return (
                <article className="card status-card" key={post.id}>
                  <div className="status-card-header">
                    <div className="status-card-title-group">
                      <div className="status-card-badges">
                        <span className={`execution-badge ${isLive ? "badge-live" : "badge-sim"}`}>
                          {isLive ? "🔴 โพสต์จริง" : "🧪 จำลอง"}
                        </span>
                        <span className="post-date-badge">
                          📅 สร้างเมื่อ: {new Date(post.created_at).toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" })}
                        </span>
                        {post.scheduled_at && new Date(post.scheduled_at).getTime() > new Date(post.created_at).getTime() + 60000 && (
                          <span className="post-schedule-badge">
                            ⏰ ตั้งเวลา: {new Date(post.scheduled_at).toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" })}
                          </span>
                        )}
                      </div>
                      <h2>{post.title}</h2>
                      {post.description && <p className="post-description status-desc-preview">{post.description}</p>}
                      {post.hashtags?.length > 0 && (
                        <p className="muted status-hashtags">{post.hashtags.map(tag => `#${tag}`).join(" ")}</p>
                      )}
                    </div>
                  </div>

                  <div className="status-targets-list">
                    <div className="targets-header-row">
                      <span className="targets-title">สถานะแต่ละช่องทาง:</span>
                      {hasPendingTarget && (
                        <span className="targets-live-indicator">
                          <Spinner label="กำลังส่งข้อมูล" /> ระบบกำลังดำเนินการอัตโนมัติ...
                        </span>
                      )}
                    </div>

                    {post.targets?.length === 0 ? (
                      <p className="muted">ไม่มีแพลตฟอร์มปลายทาง</p>
                    ) : (
                      post.targets?.map(target => {
                        const meta = PLATFORM_ICONS[target.platform] || {
                          label: target.platform,
                          icon: "🌐",
                          themeClass: "",
                        };
                        const canRetry = ["failed", "blocked"].includes(target.status) && !target.delivery_uncertain;
                        const isRetrying = retryingTargets.has(target.id);

                        return (
                          <div key={target.id} className="target-status-row">
                            <div className="target-platform-info">
                              <span className="target-platform-icon" aria-hidden="true">{meta.icon}</span>
                              <strong className="target-platform-name">{meta.label}</strong>
                              {target.status === "published" ? (
                                <span className="status-badge status-published">✅ เผยแพร่แล้ว</span>
                              ) : target.status === "simulated" ? (
                                <span className="status-badge status-simulated">🧪 จำลองสำเร็จ</span>
                              ) : ["pending", "processing"].includes(target.status) ? (
                                <span className="status-badge status-pending">
                                  <Spinner label="กำลังส่งข้อมูล" /> กำลังส่ง...
                                </span>
                              ) : target.status === "failed" ? (
                                <span className="status-badge status-failed">❌ ล้มเหลว</span>
                              ) : (
                                <span className="status-badge status-blocked">⛔ ติดเงื่อนไข / ถูกระงับ</span>
                              )}
                            </div>

                            <div className="target-actions">
                              {target.published_url && (
                                <a
                                  href={target.published_url}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="view-post-link"
                                >
                                  ดูโพสต์จริง ↗
                                </a>
                              )}

                              {canRetry && (
                                <button
                                  type="button"
                                  className="retry-target-btn"
                                  disabled={isRetrying}
                                  onClick={() => void retryTarget(target.id)}
                                >
                                  {isRetrying ? <Spinner label="กำลังลองใหม่" /> : "🔄 ลองใหม่"}
                                </button>
                              )}
                            </div>

                            {target.delivery_uncertain && (
                              <p className="error target-error-msg">
                                ⚠️ ผลการส่งไม่แน่นอน กรุณาเข้าตรวจบน {meta.label} โดยตรง ห้ามกดส่งซ้ำ
                              </p>
                            )}

                            {target.error && (
                              <p className="error target-error-msg">
                                ข้อผิดพลาด: {target.error}
                              </p>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                </article>
              );
            })
          )}
        </section>
      )}
    </>}
  </main>;
}
