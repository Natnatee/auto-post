"use client";

import { useEffect, useId, useRef, useState } from "react";

type Project = {
  id: string;
  title: string;
  description: string;
  hashtags: string[];
  price?: number | null;
  updated_at: string;
  assets: {
    media_id: string;
    role: string;
    position: number;
    media?: { filename: string; mime_type: string; size_bytes: number; status: string };
  }[];
};

type Target = {
  id: string;
  platform: string;
  status: string;
  error?: string | null;
  published_url?: string | null;
  delivery_uncertain?: boolean;
};

type Job = {
  id: string;
  status: string;
  execution_mode?: string;
  targets: Target[];
};

type Publishing = {
  jobs: Job[];
  liveEnabled?: boolean;
  destination?: { page_id: string; page_name?: string | null; enabled: boolean; live_enabled: boolean } | null;
  destinations?: {
    facebook?: { page_id: string; page_name?: string | null; enabled: boolean; live_enabled: boolean } | null;
    youtube?: { channel_id: string; channel_title?: string | null; enabled: boolean; live_enabled: boolean } | null;
    tiktok?: { creator_username?: string | null; enabled: boolean; live_enabled: boolean } | null;
    x?: { screen_name: string; enabled: boolean; live_enabled: boolean } | null;
  };
};

type PlatformKey = "facebook" | "youtube" | "tiktok";

interface PlatformMeta {
  key: PlatformKey;
  name: string;
  badge: string;
  themeClass: string;
  iconSvg: React.ReactNode;
}

const PLATFORMS: PlatformMeta[] = [
  {
    key: "facebook",
    name: "Facebook",
    badge: "เพจ Elephant-Maker",
    themeClass: "btn-platform-fb",
    iconSvg: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" />
      </svg>
    ),
  },
  {
    key: "youtube",
    name: "YouTube",
    badge: "Elephant-Maker (@mondmaker)",
    themeClass: "btn-platform-yt",
    iconSvg: (
      <svg width="19" height="19" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z" />
      </svg>
    ),
  },
  {
    key: "tiktok",
    name: "TikTok",
    badge: "Elephant-Maker",
    themeClass: "btn-platform-tt",
    iconSvg: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M19.59 6.69a4.83 4.83 0 0 1-3.77-4.25V2h-3.45v13.67a2.89 2.89 0 0 1-5.2 1.74 2.89 2.89 0 0 1 2.31-4.64c.29 0 .58.04.86.12V9.42a6.34 6.34 0 0 0-.86-.06 6.34 6.34 0 0 0-6.34 6.34 6.34 6.34 0 0 0 6.34-6.34V9.05a8.27 8.27 0 0 0 4.77 1.52v-3.4a4.84 4.84 0 0 1-1-.48z" />
      </svg>
    ),
  },
];

const active = (status: string) => ["pending", "processing", "queued", "publishing"].includes(status);

function safeUrl(value?: string | null) {
  try {
    const url = new URL(value || "");
    if (url.protocol === "https:" && !url.username && !url.password && !url.port) return url.href;
  } catch {}
  return undefined;
}

function Spinner({ label }: { label: string }) {
  return (
    <span className="loading-status" role="status" aria-label={label}>
      <span className="spinner" aria-hidden="true" />
    </span>
  );
}

export default function ProjectPublishing({ project, disabled = false }: { project: Project; disabled?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const submission = useRef<{ key: string; updatedAt: string } | null>(null);
  const lock = useRef(false);
  const titleId = useId();

  // Multi-platform selection: Default to ALL platforms selected!
  const [selectedPlatforms, setSelectedPlatforms] = useState<Set<PlatformKey>>(
    new Set(["facebook", "youtube", "tiktok"])
  );
  // Schedule: Default to "ทันที" (Immediate = null)
  const [scheduleMode, setScheduleMode] = useState<"immediate" | "scheduled">("immediate");
  const [scheduledDateTime, setScheduledDateTime] = useState<string>("");

  const [open, setOpen] = useState(false);
  const [data, setData] = useState<Publishing | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [accepted, setAccepted] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const mounted = useRef(true);
  const publishController = useRef<AbortController | null>(null);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      publishController.current?.abort();
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    async function load() {
      setLoading(true);
      try {
        const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}/publishing`, {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error("โหลดสถานะเผยแพร่ไม่สำเร็จ");
        const result: Publishing = await response.json();
        if (!Array.isArray(result.jobs)) throw new Error("รูปแบบสถานะไม่ถูกต้อง");
        if (controller.signal.aborted) return;
        setData(result);
        if (
          result.jobs.some(job => active(job.status) || job.targets?.some(target => active(target.status))) ||
          lock.current
        ) {
          timer = setTimeout(() => void load(), 4000);
        }
      } catch (cause) {
        if (!controller.signal.aborted) {
          setData(null);
          setError(cause instanceof Error ? cause.message : "โหลดสถานะไม่สำเร็จ");
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    }
    void load();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [open, project.id, refresh]);

  const caption = [
    project.title.trim(),
    project.description.trim(),
    project.price != null ? `ราคา ${Number(project.price).toFixed(2)} บาท` : "",
    project.hashtags
      .map(tag => tag.trim().replace(/^#+/, ""))
      .filter(Boolean)
      .map(tag => `#${tag}`)
      .join(" "),
  ]
    .filter(Boolean)
    .join("\n\n");

  const media = [...new Map(project.assets.map(asset => [asset.media_id, asset.media])).values()];
  const videos = media.filter(item => item?.mime_type === "video/mp4");
  const mediaError = media.some(item => !item || item.status !== "ready")
    ? "สื่อยังไม่พร้อมหรือข้อมูลสื่อไม่ครบ"
    : media.some(item => item && !["image/jpeg", "image/png", "video/mp4"].includes(item.mime_type))
    ? "รองรับเฉพาะ JPEG, PNG และ MP4"
    : media.some(
        item =>
          item &&
          (!Number.isInteger(item.size_bytes) ||
            item.size_bytes <= 0 ||
            item.size_bytes > (item.mime_type === "video/mp4" ? 2 * 1024 ** 3 : 10 * 1024 ** 2))
      )
    ? "รูปภาพต้องไม่เกิน 10 MiB และ MP4 ไม่เกิน 2 GiB"
    : videos.length > 1
    ? "รองรับวิดีโอเพียงหนึ่งไฟล์"
    : !videos.length && media.length > 1
    ? "รองรับรูปภาพเพียงหนึ่งไฟล์ (สื่อซ้ำต่างบทบาทนับครั้งเดียว)"
    : !caption || caption.length > 63206
    ? "Caption ว่างหรือยาวเกินกำหนด"
    : "";

  const destination = data?.destination;
  const pending = data?.jobs.some(job => active(job.status) || job.targets?.some(target => active(target.status)));
  const deliveryUncertain = data?.jobs.some(job => job.targets?.some(target => target.delivery_uncertain));
  const gate = !data
    ? "ยังตรวจสอบความพร้อมไม่ได้"
    : selectedPlatforms.has("facebook") && (!destination?.page_id || !/^\d+$/.test(destination.page_id))
    ? "ยังไม่มีข้อมูลเพจปลายทางจาก API — ยังไม่พร้อมโพสต์จริง"
    : selectedPlatforms.has("facebook") && !destination?.enabled
    ? "เพจปลายทางยังไม่เปิดใช้งาน"
    : selectedPlatforms.has("facebook") && (data.liveEnabled !== true || destination?.live_enabled !== true)
    ? "ระบบหรือ workspace ยังไม่เปิดโพสต์จริง"
    : selectedPlatforms.size === 0
    ? "กรุณาเลือกอย่างน้อย 1 แพลตฟอร์มปลายทาง"
    : !project.updated_at
    ? "ไม่มีเวอร์ชันโปรเจกต์สำหรับยืนยัน"
    : mediaError;
  const stale = submission.current !== null && submission.current.updatedAt !== project.updated_at;
  const blocked = loading || !!gate || !!pending || !!deliveryUncertain || accepted || stale;

  function togglePlatform(key: PlatformKey) {
    setSelectedPlatforms(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        if (next.size > 1) next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  }

  function openModal(_focusPlatform?: PlatformKey) {
    // Default to ALL platforms selected & Immediate schedule as requested
    setSelectedPlatforms(new Set(["facebook", "youtube", "tiktok"]));
    setScheduleMode("immediate");
    setScheduledDateTime("");
    setData(null);
    setConfirmed(false);
    setError("");
    setAccepted(false);
    setOpen(true);
    dialog.current?.showModal();
  }

  async function publish() {
    if (lock.current || blocked || !confirmed || (attempted && !uncertain)) return;
    lock.current = true;
    submission.current ??= { key: crypto.randomUUID(), updatedAt: project.updated_at };
    const request = submission.current;
    setBusy(true);
    setAttempted(true);
    setError("");
    setUncertain(false);
    const controller = new AbortController();
    publishController.current = controller;
    const timer = setTimeout(() => controller.abort(), 20000);

    const scheduledIso =
      scheduleMode === "scheduled" && scheduledDateTime
        ? new Date(scheduledDateTime).toISOString()
        : null;

    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(project.id)}/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          submissionKey: request.key,
          mode: "live",
          confirmLive: true,
          expectedUpdatedAt: request.updatedAt,
          platforms: Array.from(selectedPlatforms),
          scheduledAt: scheduledIso,
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        if (response.status >= 500) throw new Error("ไม่ทราบว่าระบบรับคำสั่งแล้วหรือไม่");
        if (mounted.current)
          setError(typeof body?.error === "string" ? body.error : "ระบบไม่รับคำสั่ง กรุณาตรวจสอบโปรเจกต์และสิทธิ์");
        return;
      }
      if (mounted.current) setAccepted(true);
    } catch {
      if (mounted.current) {
        setUncertain(true);
        setError("ผลคำสั่งยังไม่แน่นอน ตรวจสถานะก่อน ห้ามสร้างโพสต์ใหม่ การลองอีกครั้งจะใช้รหัสคำสั่งเดิมเท่านั้น");
      }
    } finally {
      clearTimeout(timer);
      publishController.current = null;
      lock.current = false;
      if (mounted.current) {
        setBusy(false);
        setRefresh(value => value + 1);
      }
    }
  }

  return (
    <div className="project-publishing-section">
      <div className="platform-actions-label">
        <span className="share-icon" aria-hidden="true">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="18" cy="5" r="3"></circle>
            <circle cx="6" cy="12" r="3"></circle>
            <circle cx="18" cy="19" r="3"></circle>
            <line x1="8.59" y1="13.51" x2="15.42" y2="17.49"></line>
            <line x1="15.41" y1="6.51" x2="8.59" y2="10.49"></line>
          </svg>
        </span>
        เผยแพร่อัตโนมัติ:
      </div>
      <div className="platform-button-group">
        <button
          ref={trigger}
          type="button"
          className="platform-publish-btn btn-platform-all"
          disabled={disabled}
          onClick={() => openModal()}
          title="เผยแพร่ไปยังทุกแพลตฟอร์มพร้อมกัน (Facebook, YouTube, TikTok)"
        >
          <span className="platform-icon">🚀</span>
          <span className="platform-label">เผยแพร่ทุกช่องทาง</span>
        </button>

        {PLATFORMS.map(platform => (
          <button
            key={platform.key}
            type="button"
            className={`platform-publish-btn ${platform.themeClass}`}
            disabled={disabled}
            onClick={() => openModal(platform.key)}
            title={`เผยแพร่ไปยัง ${platform.name}`}
          >
            <span className="platform-icon">{platform.iconSvg}</span>
            <span className="platform-label">{platform.name}</span>
          </button>
        ))}
      </div>

      <dialog
        ref={dialog}
        className="publishing-dialog"
        aria-labelledby={titleId}
        onClose={() => {
          setOpen(false);
          setConfirmed(false);
          if (trigger.current?.isConnected && !trigger.current.disabled) trigger.current.focus();
        }}
      >
        <div className="publishing-content">
          <div className="row">
            <h2 id={titleId} className="modal-title">
              🚀 เผยแพร่คอนเทนต์อัตโนมัติ
            </h2>
            <button type="button" autoFocus onClick={() => dialog.current?.close()}>
              ปิด
            </button>
          </div>

          <div className="publish-platform-selector">
            <label className="section-label">เลือกแพลตฟอร์มปลายทาง (ค่าเริ่มต้น: เลือกทั้งหมด):</label>
            <div className="platform-toggle-grid">
              {PLATFORMS.map(platform => {
                const isSelected = selectedPlatforms.has(platform.key);
                return (
                  <button
                    key={platform.key}
                    type="button"
                    className={`platform-toggle-chip ${platform.themeClass} ${isSelected ? "selected" : "unselected"}`}
                    onClick={() => togglePlatform(platform.key)}
                  >
                    <span className="toggle-checkbox" aria-hidden="true">
                      {isSelected ? "☑" : "☐"}
                    </span>
                    <span className="platform-icon">{platform.iconSvg}</span>
                    <span className="toggle-name">{platform.name}</span>
                  </button>
                );
              })}
            </div>
            <div className="selected-destinations-summary">
              {Array.from(selectedPlatforms).map(key => {
                const meta = PLATFORMS.find(p => p.key === key);
                return (
                  <span key={key} className="destination-badge">
                    {meta?.name}: <strong>{meta?.badge}</strong>
                  </span>
                );
              })}
            </div>
          </div>

          <div className="publish-schedule-selector">
            <label className="section-label">เวลาที่ต้องการเผยแพร่:</label>
            <div className="schedule-options">
              <label className="schedule-radio">
                <input
                  type="radio"
                  name="scheduleMode"
                  value="immediate"
                  checked={scheduleMode === "immediate"}
                  onChange={() => setScheduleMode("immediate")}
                />
                <strong>ทันที (เข้าคิวเผยแพร่ตอนนี้)</strong>
              </label>
              <label className="schedule-radio">
                <input
                  type="radio"
                  name="scheduleMode"
                  value="scheduled"
                  checked={scheduleMode === "scheduled"}
                  onChange={() => setScheduleMode("scheduled")}
                />
                <span>ตั้งเวลาล่วงหน้า:</span>
              </label>
              {scheduleMode === "scheduled" && (
                <input
                  type="datetime-local"
                  className="schedule-datetime-input"
                  value={scheduledDateTime}
                  onChange={e => setScheduledDateTime(e.target.value)}
                  min={new Date(Date.now() + 60000).toISOString().slice(0, 16)}
                />
              )}
            </div>
          </div>

          <section aria-label="ตัวอย่าง caption">
            <h3>Caption ที่จะเผยแพร่</h3>
            <pre className="publishing-caption">{caption}</pre>
          </section>

          <p className="muted">
            {videos.length
              ? `แนบ MP4: ${videos[0]?.filename} — เลือกวิดีโอก่อนเสมอ ภาพปกและ gallery จะไม่ถูกแนบและไม่ใช้เป็น thumbnail`
              : media.length === 1
              ? `แนบ: ${media[0]?.filename || "ไม่พบข้อมูลสื่อ"}`
              : media.length === 0
              ? "โพสต์ข้อความเท่านั้น"
              : "มีหลายรูปภาพ — ไม่รองรับ"}
          </p>
          <p className="muted">รองรับข้อความ / JPEG หรือ PNG หนึ่งไฟล์ ≤10 MiB / MP4 หนึ่งไฟล์ ≤2 GiB</p>
          {gate && <p className="error">{gate}</p>}
          {stale && (
            <p className="error">
              โปรเจกต์เปลี่ยนหลังส่งคำสั่งแล้ว ตรวจงานเดิมก่อน ไม่สามารถส่งซ้ำจากตัวอย่างนี้ได้
            </p>
          )}
          {pending && <p role="status">มีงานกำลังดำเนินการ ยังส่งซ้ำไม่ได้</p>}
          {deliveryUncertain && (
            <p className="error">การส่งก่อนหน้ามีผลไม่แน่นอน กรุณาตรวจสอบบนแพลตฟอร์ม ห้ามเผยแพร่ซ้ำ</p>
          )}
          {error && (
            <p role="alert" className="error">
              {error}
            </p>
          )}
          {accepted && (
            <p role="status" className="success">
              ระบบรับคำสั่งแล้ว ไม่ใช่การยืนยันว่าโพสต์สำเร็จ ตรวจสถานะด้านล่าง
            </p>
          )}

          <label className="publishing-confirm">
            <input
              type="checkbox"
              checked={confirmed}
              disabled={busy || blocked || (attempted && !uncertain)}
              onChange={event => setConfirmed(event.target.checked)}
            />
            ฉันตรวจ caption สื่อ และปลายทางทุกช่องทางแล้ว และยืนยันให้โพสต์จริง
          </label>

          <button
            type="button"
            className="primary btn-submit-all"
            disabled={busy || blocked || !confirmed || (attempted && !uncertain)}
            onClick={() => void publish()}
          >
            {busy ? (
              <>
                <Spinner label="กำลังส่งคำสั่ง…" />
                <span aria-hidden="true">กำลังส่งคำสั่ง…</span>
              </>
            ) : uncertain ? (
              "ลองคำสั่งเดิมอีกครั้ง (ไม่สร้างโพสต์ใหม่)"
            ) : (
              `ยืนยันโพสต์จริง (${selectedPlatforms.size} แพลตฟอร์ม ${scheduleMode === "immediate" ? "ทันที" : "ตามเวลา"})`
            )}
          </button>

          <section aria-label="สถานะเผยแพร่" aria-busy={loading}>
            <div className="row">
              <h3>งานเผยแพร่</h3>
              <button
                type="button"
                disabled={loading}
                onClick={() => {
                  setError("");
                  setRefresh(value => value + 1);
                }}
              >
                ตรวจสถานะ
              </button>
            </div>
            {loading && (
              <p>
                <Spinner label="กำลังโหลดสถานะ…" />
                <span aria-hidden="true">กำลังโหลดสถานะ…</span>
              </p>
            )}
            {data?.jobs.length === 0 && <p className="muted">ยังไม่มีงานเผยแพร่</p>}
            {data?.jobs.map(job => (
              <article className="publishing-job" key={job.id}>
                <p>
                  {job.execution_mode || "ไม่ระบุโหมด"} · {job.status}
                </p>
                <small>{job.id}</small>
                {job.targets?.map(target => {
                  const url = safeUrl(target.published_url);
                  return (
                    <div key={target.id}>
                      <p>
                        {target.platform} · {target.status}
                      </p>
                      {target.error && <p className="error">{target.error}</p>}
                      {target.delivery_uncertain && (
                        <p className="error">ผลการส่งไม่แน่นอน — ตรวจบนแพลตฟอร์มก่อน ห้ามส่งซ้ำ</p>
                      )}
                      {url && (
                        <a href={url} target="_blank" rel="noopener noreferrer">
                          ดูโพสต์ ↗
                        </a>
                      )}
                    </div>
                  );
                })}
              </article>
            ))}
          </section>
        </div>
      </dialog>
    </div>
  );
}
