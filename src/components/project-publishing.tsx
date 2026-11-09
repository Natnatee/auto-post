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

function getNextOccurrence(hour: number, minute: number): { iso: string; localInput: string; display: string } {
  const now = new Date();
  const target = new Date(now);
  target.setHours(hour, minute, 0, 0);

  if (target.getTime() <= now.getTime() + 2 * 60 * 1000) {
    target.setDate(target.getDate() + 1);
  }

  const year = target.getFullYear();
  const month = String(target.getMonth() + 1).padStart(2, "0");
  const day = String(target.getDate()).padStart(2, "0");
  const hh = String(target.getHours()).padStart(2, "0");
  const mm = String(target.getMinutes()).padStart(2, "0");

  const localInput = `${year}-${month}-${day}T${hh}:${mm}`;
  const isTomorrow = target.getDate() !== now.getDate();
  const display = `${isTomorrow ? "พรุ่งนี้ " : "วันนี้ "}${hh}:${mm} น.`;

  return { iso: target.toISOString(), localInput, display };
}

type PresetOption = "now" | "1130" | "2000" | "2200" | "custom";

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
  // Facebook media choice: Default to "photo", other platforms use video
  const [facebookMediaType, setFacebookMediaType] = useState<"photo" | "video">("photo");
  // Schedule: Default to "ทันที" (Immediate = null)
  const [scheduleMode, setScheduleMode] = useState<"immediate" | "scheduled">("immediate");
  const [selectedPreset, setSelectedPreset] = useState<PresetOption>("now");
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

  const websiteUrl = "https://www.elephant-maker.com/";
  const hasWebsite = project.description?.includes("elephant-maker.com");

  const caption = [
    project.title.trim(),
    project.description.trim(),
    project.price != null ? `ราคา ${Number(project.price).toFixed(2)} บาท` : "",
    !hasWebsite ? `🌐 ดูเพิ่มเติมได้ที่: ${websiteUrl}` : "",
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
  const photos = media.filter(item => item && ["image/jpeg", "image/png"].includes(item.mime_type));
  const hasVideo = videos.length > 0;
  const hasPhoto = photos.length > 0;

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
    : selectedPlatforms.has("youtube") && !hasVideo
    ? "YouTube จำเป็นต้องมีวิดีโอ MP4"
    : selectedPlatforms.has("tiktok") && !hasVideo
    ? "TikTok จำเป็นต้องมีวิดีโอ MP4"
    : selectedPlatforms.has("facebook") && facebookMediaType === "video" && !hasVideo
    ? "Facebook ในโหมดวิดีโอ จำเป็นต้องมีวิดีโอ MP4"
    : selectedPlatforms.has("facebook") && facebookMediaType === "photo" && !hasPhoto
    ? "Facebook ในโหมดรูปภาพ จำเป็นต้องมีรูปภาพ (JPEG หรือ PNG)"
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
    setFacebookMediaType(hasPhoto ? "photo" : "video");
    setScheduleMode("immediate");
    setSelectedPreset("now");
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
          facebookMediaType: facebookMediaType,
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

          <div className="publish-media-format-selector">
            <label className="section-label">🎬 รูปแบบสื่อสำหรับแต่ละช่องทาง:</label>
            
            {selectedPlatforms.has("facebook") && (
              <div className="facebook-format-box">
                <span style={{ fontSize: "13px", fontWeight: 600, display: "block", marginBottom: "6px" }}>
                  📘 Facebook: ให้เลือกว่าจะลงเป็น <strong>รูปภาพ</strong> หรือ <strong>วิดีโอ</strong>
                </span>
                <div className="media-format-options">
                  <label className={`media-format-card ${facebookMediaType === "photo" ? "active" : ""}`}>
                    <input
                      type="radio"
                      name="fbFormat"
                      value="photo"
                      checked={facebookMediaType === "photo"}
                      onChange={() => setFacebookMediaType("photo")}
                      disabled={!hasPhoto}
                    />
                    <span className="media-format-title">
                      <span>📸 รูปภาพ (ค่าเริ่มต้น)</span>
                      {facebookMediaType === "photo" && <span className="media-format-check">✓</span>}
                    </span>
                    <span className="media-format-desc">
                      ลงเป็นรูปภาพพร้อมลิงก์เว็บและคำอธิบายครบถ้วน (แนะนำสำหรับกลุ่มและเพจ คนสนใจสูงกว่า)
                    </span>
                  </label>

                  <label className={`media-format-card ${facebookMediaType === "video" ? "active" : ""}`}>
                    <input
                      type="radio"
                      name="fbFormat"
                      value="video"
                      checked={facebookMediaType === "video"}
                      onChange={() => setFacebookMediaType("video")}
                      disabled={!hasVideo}
                    />
                    <span className="media-format-title">
                      <span>🎥 วิดีโอ</span>
                      {facebookMediaType === "video" && <span className="media-format-check">✓</span>}
                    </span>
                    <span className="media-format-desc">
                      ลงเป็นไฟล์วิดีโอ MP4 หน้าเพจ
                    </span>
                  </label>
                </div>
                {!hasPhoto && <p className="muted" style={{ color: "#d97706", marginTop: "4px", fontSize: "12px" }}>⚠️ โปรเจกต์นี้ไม่มีไฟล์รูปภาพ ระบบจะใช้โหมดวิดีโอ</p>}
                {!hasVideo && <p className="muted" style={{ color: "#d97706", marginTop: "4px", fontSize: "12px" }}>⚠️ โปรเจกต์นี้ไม่มีไฟล์วิดีโอ</p>}
              </div>
            )}

            <div className="media-format-badge-row">
              {selectedPlatforms.has("youtube") && (
                <span className="media-format-badge-item">🔴 YouTube: <strong>🎥 วิดีโอ (Shorts)</strong></span>
              )}
              {selectedPlatforms.has("tiktok") && (
                <span className="media-format-badge-item">🎵 TikTok: <strong>🎥 วิดีโอ</strong></span>
              )}
            </div>
          </div>

          <div className="publish-schedule-selector">
            <label className="section-label">⏰ เลือกช่วงเวลาเผยแพร่:</label>
            <div className="schedule-preset-grid">
              <button
                type="button"
                className={`schedule-preset-btn ${selectedPreset === "now" ? "active" : ""}`}
                onClick={() => {
                  setSelectedPreset("now");
                  setScheduleMode("immediate");
                  setScheduledDateTime("");
                }}
              >
                <span className="preset-name">⚡ ทันที</span>
                <span className="preset-sub">เข้าคิวเผยแพร่ตอนนี้</span>
              </button>

              <button
                type="button"
                className={`schedule-preset-btn ${selectedPreset === "1130" ? "active" : ""}`}
                onClick={() => {
                  const next = getNextOccurrence(11, 30);
                  setSelectedPreset("1130");
                  setScheduleMode("scheduled");
                  setScheduledDateTime(next.localInput);
                }}
              >
                <span className="preset-name">🍱 11:30 น.</span>
                <span className="preset-sub">{getNextOccurrence(11, 30).display} (พักเที่ยง)</span>
              </button>

              <button
                type="button"
                className={`schedule-preset-btn ${selectedPreset === "2000" ? "active" : ""}`}
                onClick={() => {
                  const next = getNextOccurrence(20, 0);
                  setSelectedPreset("2000");
                  setScheduleMode("scheduled");
                  setScheduledDateTime(next.localInput);
                }}
              >
                <span className="preset-name">🌙 20:00 น.</span>
                <span className="preset-sub">{getNextOccurrence(20, 0).display} (หัวค่ำ)</span>
              </button>

              <button
                type="button"
                className={`schedule-preset-btn ${selectedPreset === "2200" ? "active" : ""}`}
                onClick={() => {
                  const next = getNextOccurrence(22, 0);
                  setSelectedPreset("2200");
                  setScheduleMode("scheduled");
                  setScheduledDateTime(next.localInput);
                }}
              >
                <span className="preset-name">💻 22:00 น.</span>
                <span className="preset-sub">{getNextOccurrence(22, 0).display} (สาย Maker)</span>
              </button>

              <button
                type="button"
                className={`schedule-preset-btn ${selectedPreset === "custom" ? "active" : ""}`}
                onClick={() => {
                  setSelectedPreset("custom");
                  setScheduleMode("scheduled");
                  if (!scheduledDateTime) {
                    const defaultCustom = new Date(Date.now() + 60 * 60 * 1000);
                    const y = defaultCustom.getFullYear();
                    const m = String(defaultCustom.getMonth() + 1).padStart(2, "0");
                    const d = String(defaultCustom.getDate()).padStart(2, "0");
                    const hh = String(defaultCustom.getHours()).padStart(2, "0");
                    const mm = String(defaultCustom.getMinutes()).padStart(2, "0");
                    setScheduledDateTime(`${y}-${m}-${d}T${hh}:${mm}`);
                  }
                }}
              >
                <span className="preset-name">📅 กำหนดเอง</span>
                <span className="preset-sub">เลือกวัน-เวลาเฉพาะ</span>
              </button>
            </div>

            {scheduleMode === "scheduled" && (
              <div className="schedule-custom-box">
                <label className="schedule-custom-label">
                  {selectedPreset === "custom" ? "ระบุวันและเวลาที่ต้องการโพสต์:" : "เวลาที่จะเผยแพร่ (สามารถปรับเปลี่ยนได้):"}
                </label>
                <input
                  type="datetime-local"
                  className="schedule-datetime-input"
                  value={scheduledDateTime}
                  onChange={e => {
                    setScheduledDateTime(e.target.value);
                    setSelectedPreset("custom");
                  }}
                  min={new Date(Date.now() + 60000).toISOString().slice(0, 16)}
                />
                {scheduledDateTime && (
                  <span className="schedule-summary-text">
                    🕒 ระบบจะเผยแพร่อัตโนมัติใน: <strong>{new Date(scheduledDateTime).toLocaleString("th-TH", { dateStyle: "medium", timeStyle: "short" })}</strong>
                  </span>
                )}
              </div>
            )}
          </div>

          <section aria-label="ตัวอย่าง caption">
            <h3>Caption ที่จะเผยแพร่</h3>
            <pre className="publishing-caption">{caption}</pre>
          </section>

          <div className="publishing-media-summary" style={{ fontSize: "13px", color: "var(--muted)", display: "flex", flexDirection: "column", gap: "4px" }}>
            {selectedPlatforms.has("facebook") && (
              <p style={{ margin: 0 }}>
                📘 <strong>Facebook:</strong> จะเผยแพร่เป็น <strong>{facebookMediaType === "photo" ? "📸 รูปภาพ (ภาพปก)" : "🎥 วิดีโอ MP4"}</strong>
              </p>
            )}
            {selectedPlatforms.has("youtube") && (
              <p style={{ margin: 0 }}>
                🔴 <strong>YouTube:</strong> จะเผยแพร่เป็น <strong>🎥 วิดีโอ (Shorts)</strong>
              </p>
            )}
            {selectedPlatforms.has("tiktok") && (
              <p style={{ margin: 0 }}>
                🎵 <strong>TikTok:</strong> จะเผยแพร่เป็น <strong>🎥 วิดีโอ</strong>
              </p>
            )}
          </div>
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
