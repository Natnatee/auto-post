import { database } from "./cloud-db.mjs";

process.loadEnvFile(".env.tiktok");

const token = process.env.TIKTOK_ACCESS_TOKEN;
console.log("Token prefix:", token?.slice(0, 15));

// Check target details
const db = database();
await db.connect();
const target = (await db.query(`
  SELECT t.*, p.title, p.description, p.hashtags, p.content_snapshot
  FROM public.post_targets t
  JOIN public.posts p ON p.id = t.post_id
  WHERE t.id = '3c08c44f-fc92-4b3b-a357-294663c3aaa8'
`)).rows[0];
await db.end();

console.log("Target snapshot assets:", target.content_snapshot?.assets);
console.log("Title / Caption:", target.title);

const payload = {
  post_info: {
    title: target.title || "Bat_Halloween",
    privacy_level: "SELF_ONLY",
    disable_duet: false,
    disable_stitch: false,
    disable_comment: false,
    video_cover_timestamp_ms: 1000,
  },
  source_info: {
    source: "FILE_UPLOAD",
    video_size: 1530910, // approximate or exact size
    chunk_size: 1530910,
    total_chunk_count: 1,
  },
};

console.log("Testing POST to https://open.tiktokapis.com/v2/post/publish/video/init/ ...");
const res = await fetch("https://open.tiktokapis.com/v2/post/publish/video/init/", {
  method: "POST",
  headers: {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json; charset=UTF-8",
  },
  body: JSON.stringify(payload),
});

const body = await res.json();
console.log("HTTP status:", res.status);
console.log("TikTok API response:", JSON.stringify(body, null, 2));

