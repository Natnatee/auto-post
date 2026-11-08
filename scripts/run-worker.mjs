import { existsSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { YouTubeAdapter } from "../src/lib/youtube.ts";
import { TikTokAdapter } from "../src/lib/tiktok.ts";
import { XAdapter } from "../src/lib/x.ts";

function loadEnvIfPresent(file) {
  if (existsSync(file)) {
    process.loadEnvFile(file);
  }
}

loadEnvIfPresent(".env");
loadEnvIfPresent(".env.admin");
loadEnvIfPresent(".env.facebook");
loadEnvIfPresent(".env.youtube");
loadEnvIfPresent(".env.tiktok");
loadEnvIfPresent(".env.x");

const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/+$/, "");
const supabaseKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY");
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function getSignedUrl(objectPath) {
  const { data, error } = await supabase.storage.from("social-media").createSignedUrl(objectPath, 3600);
  if (error || !data?.signedUrl) throw new Error("Failed to get signed URL: " + (error?.message || "unknown"));
  return data.signedUrl;
}

async function processFacebook(target, snap, signedUrl) {
  const pageId = process.env.FACEBOOK_PAGE_ID || "1182106911641987";
  const token = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
  const version = process.env.FACEBOOK_GRAPH_VERSION || "v27.0";

  if (!token) throw new Error("Missing Facebook Page Access Token");

  const caption = [
    snap.title?.trim(),
    snap.description?.trim(),
    snap.price != null ? `ราคา ${Number(snap.price).toFixed(2)} บาท` : "",
    (snap.hashtags || []).map(t => `#${t.replace(/^#+/, "")}`).join(" ")
  ].filter(Boolean).join("\n\n");

  const assets = snap.assets || [];
  const videoAsset = assets.find(a => a.mime_type === "video/mp4");

  let endpoint;
  let payload;
  if (videoAsset && signedUrl) {
    endpoint = "videos";
    payload = { file_url: signedUrl, description: caption, published: true };
  } else if (signedUrl) {
    endpoint = "photos";
    payload = { url: signedUrl, caption };
  } else {
    endpoint = "feed";
    payload = { message: caption };
  }

  const res = await fetch(`https://graph.facebook.com/${version}/${pageId}/${endpoint}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const data = await res.json();
  if (!res.ok) {
    throw new Error(`Facebook API error: ${JSON.stringify(data.error || data)}`);
  }

  const externalId = data.id || data.post_id;
  const publishedUrl = `https://www.facebook.com/${externalId}`;
  return { status: "published", error: null, external_post_id: externalId, published_url: publishedUrl };
}

async function processYouTube(target, snap, signedUrl) {
  const yt = new YouTubeAdapter({
    clientId: process.env.YOUTUBE_CLIENT_ID || "",
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET || "",
    refreshToken: process.env.YOUTUBE_REFRESH_TOKEN || "",
    liveEnabled: process.env.YOUTUBE_LIVE_ENABLED === "true",
  });

  const assets = snap.assets || [];
  const videoAsset = assets.find(a => a.mime_type === "video/mp4");

  if (!videoAsset || !signedUrl) {
    return {
      status: "blocked",
      error: "YouTube requires MP4 video",
      external_post_id: null,
      published_url: null
    };
  }

  const res = await yt.publishFromUrl(signedUrl, {
    title: snap.title || "Elephant-Maker Creation",
    description: [
      snap.description || "",
      snap.price != null ? `ราคา: ${snap.price} บาท` : "",
      (snap.hashtags || []).map(t => `#${t}`).join(" ")
    ].filter(Boolean).join("\n\n"),
    tags: snap.hashtags || [],
    privacyStatus: "public",
  }, "live");

  return {
    status: res.status,
    error: res.error,
    external_post_id: res.videoId,
    published_url: res.publishedUrl
  };
}

async function processX(target, snap) {
  const x = new XAdapter({
    apiKey: process.env.X_API_KEY || "",
    apiSecret: process.env.X_API_SECRET || "",
    accessToken: process.env.X_ACCESS_TOKEN || "",
    accessSecret: process.env.X_ACCESS_SECRET || "",
    liveEnabled: process.env.X_LIVE_ENABLED === "true",
  });

  const fullText = [
    snap.title?.trim(),
    snap.description?.trim(),
    snap.price != null ? `ราคา ${Number(snap.price).toFixed(2)} บาท` : "",
    (snap.hashtags || []).map(t => `#${t.replace(/^#+/, "")}`).join(" ")
  ].filter(Boolean).join("\n\n");

  // X text limit 280 chars
  const tweetText = fullText.length <= 280 ? fullText : fullText.slice(0, 277) + "...";

  const res = await x.postTweet({ text: tweetText }, "live");
  return {
    status: res.status,
    error: res.error,
    external_post_id: res.tweetId,
    published_url: res.publishedUrl
  };
}

async function processTikTok(target, snap, signedUrl) {
  const tt = new TikTokAdapter({
    clientKey: process.env.TIKTOK_CLIENT_KEY || "",
    clientSecret: process.env.TIKTOK_CLIENT_SECRET || "",
    redirectUri: "https://auto-post.dev/oauth/tiktok/callback",
    accessToken: process.env.TIKTOK_ACCESS_TOKEN || "",
    liveEnabled: process.env.TIKTOK_LIVE_ENABLED === "true",
  });

  const assets = snap.assets || [];
  const videoAsset = assets.find(a => a.mime_type === "video/mp4");

  if (!videoAsset || !signedUrl) {
    return {
      status: "simulated",
      error: "TikTok requires MP4 video; simulated because no video asset provided",
      external_post_id: null,
      published_url: null
    };
  }

  // If TikTok direct user access token isn't authorized yet, return blocked with clear explanation
  if (!process.env.TIKTOK_ACCESS_TOKEN) {
    return {
      status: "blocked",
      error: "TikTok Direct Post requires user OAuth authorization token",
      external_post_id: null,
      published_url: null
    };
  }

  const res = await tt.publishFromUrl(signedUrl, {
    title: snap.title || "Elephant-Maker Creation",
    privacyLevel: "PUBLIC_TO_EVERYONE"
  }, "live");

  return {
    status: res.status,
    error: res.error,
    external_post_id: res.publishId,
    published_url: res.publishedUrl
  };
}

export async function processOneTarget() {
  const { data: target, error: claimErr } = await supabase.rpc("claim_target", { p_lease_seconds: 300 });
  if (claimErr) {
    console.warn("Claim error:", claimErr.message);
    return false;
  }
  if (!target || !target.id) return false;

  console.log(`[Worker] Claimed target: ${target.id} (${target.platform}) for post ${target.post_id}`);

  const snap = target.content_snapshot || {};
  const assets = snap.assets || [];
  const videoAsset = assets.find(a => a.mime_type === "video/mp4");
  const firstAsset = videoAsset || assets[0];

  let signedUrl = null;
  if (firstAsset?.object_path) {
    try {
      signedUrl = await getSignedUrl(firstAsset.object_path);
    } catch (e) {
      console.warn("Failed to sign URL:", e.message);
    }
  }

  // Authorize dispatch
  const { data: dispatchOk, error: dispatchErr } = await supabase.rpc("begin_target_dispatch", {
    p_target_id: target.id,
    p_lease_token: target.lease_token,
  });

  if (dispatchErr || dispatchOk !== true) {
    console.warn(`[Worker] Dispatch authorization failed for ${target.platform}:`, dispatchErr?.message || "not accepted");
    await supabase.rpc("finish_target", {
      p_target_id: target.id,
      p_lease_token: target.lease_token,
      p_status: "blocked",
      p_error: "Dispatch authorization rejected",
      p_published_url: null,
      p_external_post_id: null,
      p_delivery_uncertain: false,
    });
    return true;
  }

  let result = { status: "failed", error: "Unknown error", external_post_id: null, published_url: null };
  try {
    if (target.platform === "facebook") {
      result = await processFacebook(target, snap, signedUrl);
    } else if (target.platform === "youtube") {
      result = await processYouTube(target, snap, signedUrl);
    } else if (target.platform === "x") {
      result = await processX(target, snap);
    } else if (target.platform === "tiktok") {
      result = await processTikTok(target, snap, signedUrl);
    } else {
      result = { status: "blocked", error: `Unsupported platform: ${target.platform}` };
    }
  } catch (err) {
    console.error(`[Worker] Publish error on ${target.platform}:`, err.message);
    result = { status: "failed", error: err.message, external_post_id: null, published_url: null };
  }

  console.log(`[Worker] Result for ${target.platform}:`, result);

  const { data: finishOk, error: finishErr } = await supabase.rpc("finish_target", {
    p_target_id: target.id,
    p_lease_token: target.lease_token,
    p_status: result.status,
    p_error: result.error,
    p_published_url: result.published_url,
    p_external_post_id: result.external_post_id,
    p_delivery_uncertain: false,
  });

  if (finishErr) {
    console.error(`[Worker] Finish error for ${target.id}:`, finishErr.message);
  } else {
    console.log(`[Worker] Target ${target.id} finished successfully (${result.status})`);
  }

  return true;
}

async function main() {
  const once = process.argv.includes("--once");
  console.log(`[Worker] Starting multi-platform worker (mode: ${once ? "single-run" : "continuous"})...`);

  do {
    let handled = false;
    try {
      handled = await processOneTarget();
    } catch (e) {
      console.error("[Worker] Loop error:", e.message);
    }
    if (once) break;
    if (!handled) {
      await new Promise(r => setTimeout(r, 4000));
    }
  } while (true);
}

if (process.argv[1] && process.argv[1].endsWith("run-worker.mjs")) {
  main().catch(console.error);
}
