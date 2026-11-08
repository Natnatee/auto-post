import { z } from "zod";
export const platforms = ["x", "facebook", "tiktok", "youtube"] as const;
export const mediaTypes = ["image/jpeg", "image/png", "image/webp", "video/mp4", "video/webm", "video/quicktime"] as const;
export const loginSchema = z.object({ email: z.email().max(320), password: z.string().min(1).max(1024) });
export const uploadSchema = z.object({
  filename: z.string().trim().min(1).max(500).refine(s => !/[\x00-\x1f]/.test(s), "ชื่อไฟล์ไม่ถูกต้อง"),
  mimeType: z.enum(mediaTypes), sizeBytes: z.number().int().positive().max(2 * 1024 ** 3)
});
export const postSchema = z.object({
  title: z.string().trim().min(1).max(500),
    description: z.string().trim().max(5000).default(""),
  hashtags: z.array(z.string().trim().min(1).max(100)).max(30),
  platforms: z.array(z.enum(platforms)).min(1).max(4).refine(v => new Set(v).size === v.length),
  mediaIds: z.array(z.uuid()).min(1).max(10).refine(v => new Set(v).size === v.length),
  scheduledAt: z.iso.datetime({ offset: true }).nullable(),
});
export const contentProjectSchema = z.object({
  projectId: z.uuid().optional(), workspaceId: z.uuid().optional(),
    price: z.number().min(0).max(9999999999.99).multipleOf(0.01).nullable().default(null),
  title: z.string().trim().min(1).max(500),
  description: z.string().trim().max(5000).default(""),
  hashtags: z.array(z.string().trim().min(1).max(100)).max(30),
  assets: z.array(z.object({ media_id: z.uuid(), role: z.enum(["video", "cover", "gallery"]), position: z.number().int().min(0).max(1000) })).max(12)
    .refine(items => new Set(items.map(item => `${item.media_id}:${item.role}`)).size === items.length, "สื่อซ้ำในบทบาทเดียวกัน")
    .refine(items => items.filter(item => item.role === "video").length <= 1 && items.filter(item => item.role === "cover").length <= 1 && items.filter(item => item.role === "gallery").length <= 10, "จำกัดวิดีโอและภาพปกอย่างละหนึ่งไฟล์ ภาพรองสิบไฟล์")
    .refine(items => new Set(items.map(item => `${item.role}:${item.position}`)).size === items.length, "ตำแหน่งซ้ำ"),
});
export const publishProjectSchema = z.object({
  submissionKey: z.uuid(),
  scheduledAt: z.string().trim().min(1).nullable().default(null),
  mode: z.enum(["simulation", "live"]).default("simulation"),
  confirmLive: z.boolean().default(false),
  expectedUpdatedAt: z.string().trim().min(1).optional(),
  platforms: z.array(z.enum(["facebook", "youtube", "tiktok", "x"])).min(1).default(["facebook", "youtube", "tiktok"]),
  platform: z.enum(["facebook", "youtube", "tiktok", "x"]).optional(),
}).passthrough();
export const extensions: Record<(typeof mediaTypes)[number], string> = {
  "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
};
