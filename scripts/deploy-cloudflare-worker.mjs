// Safe Cloudflare Worker deployment & secret sync helper.
// Never logs or prints secret values; pipes secrets via stdin to Wrangler.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run") || args.has("--check");

function loadEnvIfPresent(file) {
  if (existsSync(file)) {
    process.loadEnvFile(file);
  }
}

loadEnvIfPresent(".env");
loadEnvIfPresent(".env.admin");
loadEnvIfPresent(".env.cloudflare");
loadEnvIfPresent(".env.facebook");
loadEnvIfPresent(".env.youtube");
loadEnvIfPresent(".env.tiktok");
loadEnvIfPresent(".env.x");

const supabaseUrl = (process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const supabaseSecret = (
  process.env.SUPABASE_SECRET_KEY ||
  process.env.SUPABASE_SERVICE_ROLE_KEY ||
  ""
).trim();
const fbToken = (process.env.FACEBOOK_PAGE_ACCESS_TOKEN || "").trim();
const fbPageId = (process.env.FACEBOOK_PAGE_ID || "").trim();

function runWrangler(wranglerArgs, input) {
  const result = spawnSync(
    process.platform === "win32" ? "pnpm.cmd" : "pnpm",
    ["dlx", "wrangler@3", ...wranglerArgs],
    {
      input,
      stdio: [input ? "pipe" : "inherit", "inherit", "inherit"],
      encoding: "utf8",
      shell: process.platform === "win32",
    }
  );
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

if (dryRun) {
  console.log("Checking Cloudflare Worker bundle (--dry-run)...");
  runWrangler(["deploy", "--dry-run"]);
  console.log("Cloudflare Worker bundle check passed.");
  process.exit(0);
}

if (!supabaseUrl || !supabaseSecret) {
  console.error("Missing SUPABASE_URL or SUPABASE_SECRET_KEY in local .env / .env.admin");
  process.exit(1);
}

console.log("1/2 Deploying auto-post-worker to Cloudflare...");
runWrangler(["deploy"]);

const secretsPayload = {
  SUPABASE_URL: supabaseUrl,
  SUPABASE_SECRET_KEY: supabaseSecret,
  ...(fbToken ? { FACEBOOK_PAGE_ACCESS_TOKEN: fbToken } : {}),
  ...(fbPageId ? { FACEBOOK_PAGE_ID: fbPageId } : {}),
  ...(process.env.YOUTUBE_CLIENT_ID ? { YOUTUBE_CLIENT_ID: process.env.YOUTUBE_CLIENT_ID } : {}),
  ...(process.env.YOUTUBE_CLIENT_SECRET ? { YOUTUBE_CLIENT_SECRET: process.env.YOUTUBE_CLIENT_SECRET } : {}),
  ...(process.env.YOUTUBE_REFRESH_TOKEN ? { YOUTUBE_REFRESH_TOKEN: process.env.YOUTUBE_REFRESH_TOKEN } : {}),
  ...(process.env.TIKTOK_CLIENT_KEY ? { TIKTOK_CLIENT_KEY: process.env.TIKTOK_CLIENT_KEY } : {}),
  ...(process.env.TIKTOK_CLIENT_SECRET ? { TIKTOK_CLIENT_SECRET: process.env.TIKTOK_CLIENT_SECRET } : {}),
  ...(process.env.TIKTOK_ACCESS_TOKEN ? { TIKTOK_ACCESS_TOKEN: process.env.TIKTOK_ACCESS_TOKEN } : {}),
  ...(process.env.TIKTOK_REFRESH_TOKEN ? { TIKTOK_REFRESH_TOKEN: process.env.TIKTOK_REFRESH_TOKEN } : {}),
  ...(process.env.X_API_KEY ? { X_API_KEY: process.env.X_API_KEY } : {}),
  ...(process.env.X_API_SECRET ? { X_API_SECRET: process.env.X_API_SECRET } : {}),
  ...(process.env.X_ACCESS_TOKEN ? { X_ACCESS_TOKEN: process.env.X_ACCESS_TOKEN } : {}),
  ...(process.env.X_ACCESS_SECRET ? { X_ACCESS_SECRET: process.env.X_ACCESS_SECRET } : {}),
};

console.log(
  `2/2 Uploading ${Object.keys(secretsPayload).length} encrypted secrets (${Object.keys(
    secretsPayload
  ).join(", ")}) to Cloudflare Worker...`
);
runWrangler(["secret", "bulk"], JSON.stringify(secretsPayload));
console.log("Cloudflare Worker deployed and secrets synced (WORKER_MODE from wrangler.jsonc vars).");

