// TikTok OAuth 2.0 Authorization & Token Exchange Script
// Generates authorization URL, exchanges authorization code for user access token & refresh token,
// and saves credentials securely to .env.tiktok.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

function loadEnvIfPresent(file) {
  if (existsSync(file)) {
    process.loadEnvFile(file);
  }
}

loadEnvIfPresent(".env.tiktok");

const args = process.argv.slice(2);
const isSandbox = args.includes("--sandbox");

const clientKey = isSandbox
  ? (process.env.TIKTOK_SANDBOX_CLIENT_KEY || "").trim()
  : (process.env.TIKTOK_CLIENT_KEY || "").trim();

const clientSecret = isSandbox
  ? (process.env.TIKTOK_SANDBOX_CLIENT_SECRET || "").trim()
  : (process.env.TIKTOK_CLIENT_SECRET || "").trim();

const redirectUri = (process.env.TIKTOK_REDIRECT_URI || "https://autopost.com/callback").trim();

if (!clientKey || !clientSecret) {
  console.error("Missing TikTok Client Key or Client Secret in .env.tiktok");
  process.exit(1);
}

const authBase = "https://www.tiktok.com/v2/auth/authorize/";
const tokenBase = isSandbox
  ? "https://open-api.tiktok.com/v2/oauth/token/"
  : "https://open.tiktokapis.com/v2/oauth/token/";

const scopes = "user.info.basic,video.publish,video.upload";
const state = "autopost_tiktok_" + Math.random().toString(36).substring(2, 10);

const authUrl = new URL(authBase);
authUrl.searchParams.set("client_key", clientKey);
authUrl.searchParams.set("scope", scopes);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("redirect_uri", redirectUri);
authUrl.searchParams.set("state", state);

// Check if user provided a code or URL as argument
const inputArg = args.find(a => !a.startsWith("--"));

if (!inputArg) {
  console.log("==================================================================");
  console.log("       TikTok OAuth Authorization (" + (isSandbox ? "SANDBOX" : "PRODUCTION") + ")");
  console.log("==================================================================");
  console.log("\n1. กรุณาเปิดลิงก์นี้ในเบราว์เซอร์เพื่อเข้าสู่ระบบ TikTok และกดยินยอม (Authorize):");
  console.log("\n" + authUrl.toString() + "\n");
  console.log("2. เมื่อกดยินยอมแล้ว เบราว์เซอร์จะ redirect ไปยังหน้า URL ปลายทาง เช่น:");
  console.log("   https://autopost.com/callback?code=xxxxxx&state=... (หรือหน้านั้นอาจขึ้น 404 ซึ่งไม่เป็นไร)");
  console.log("\n3. คัดลอก URL หรือค่า `code` ที่ได้จากแถบ Address Bar ของเบราว์เซอร์");
  console.log("   แล้วนำมารันคำสั่งนี้:");
  console.log("   node scripts/exchange-tiktok-token.mjs <URLหรือCODE>");
  console.log("==================================================================");
  process.exit(0);
}

// Extract code from inputArg (could be raw code or full URL)
let code = inputArg.trim();
if (code.includes("code=")) {
  try {
    const parsed = new URL(code.startsWith("http") ? code : `https://${code}`);
    code = parsed.searchParams.get("code") || code;
  } catch {
    const match = code.match(/[?&]code=([^&]+)/);
    if (match) code = match[1];
  }
}

console.log("กำลังแลกเปลี่ยน Authorization Code กับ TikTok API...");

try {
  const tokenRes = await fetch(tokenBase, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Cache-Control": "no-cache",
    },
    body: new URLSearchParams({
      client_key: clientKey,
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
      redirect_uri: redirectUri,
    }),
  });

  const body = await tokenRes.json();

  if (!tokenRes.ok || body.error || !body.access_token) {
    console.error("TikTok token exchange failed:");
    console.error(JSON.stringify(body, null, 2));
    process.exit(1);
  }

  const { access_token, refresh_token, open_id, expires_in, refresh_expires_in } = body;

  console.log("แลกเปลี่ยน Token สำเร็จ!");
  console.log("- Open ID:", open_id || "N/A");
  console.log("- Access Token อายุ:", expires_in, "วินาที (~" + Math.round(expires_in / 3600) + " ชม.)");
  console.log("- Refresh Token อายุ:", refresh_expires_in, "วินาที (~" + Math.round(refresh_expires_in / 86400) + " วัน)");

  // Read current .env.tiktok
  let envLines = [];
  if (existsSync(".env.tiktok")) {
    const content = await readFile(".env.tiktok", "utf8");
    envLines = content.split("\n");
  }

  // Update or append tokens
  function setEnvVar(name, value) {
    const idx = envLines.findIndex(line => line.startsWith(`${name}=`));
    if (idx >= 0) {
      envLines[idx] = `${name}=${value}`;
    } else {
      envLines.push(`${name}=${value}`);
    }
  }

  setEnvVar("TIKTOK_ACCESS_TOKEN", access_token);
  if (refresh_token) {
    setEnvVar("TIKTOK_REFRESH_TOKEN", refresh_token);
  }
  setEnvVar("TIKTOK_LIVE_ENABLED", "true");

  await writeFile(".env.tiktok", envLines.join("\n"), "utf8");
  console.log("บันทึก TIKTOK_ACCESS_TOKEN และ TIKTOK_REFRESH_TOKEN ลงใน .env.tiktok เรียบร้อยแล้ว!");

} catch (err) {
  console.error("เกิดข้อผิดพลาดในการเชื่อมต่อกับ TikTok:", err);
  process.exit(1);
}

