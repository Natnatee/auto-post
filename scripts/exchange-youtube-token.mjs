// OAuth token exchange helper for YouTube Data API v3.
// Spins up a local temporary HTTP server, opens the browser to authorize,
// and saves the long-lived refresh token directly into .env.youtube.
import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";

const secretFile = "C:/Users/natna/Downloads/client_secret_451214672908-q1tsshuosgkv6ocf9qb34m4mhks45agt.apps.googleusercontent.com.json";

if (!existsSync(secretFile)) {
  console.error("Client secret file not found at:", secretFile);
  process.exit(1);
}

const secretData = JSON.parse(await readFile(secretFile, "utf8"));
const installed = secretData.installed || secretData.web;
const { client_id, client_secret } = installed;

const PORT = 8990;
const REDIRECT_URI = `http://localhost:${PORT}/oauth2callback`;

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", client_id);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", "https://www.googleapis.com/auth/youtube.upload");
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent");

console.log("Starting temporary local callback server on port", PORT);

const server = createServer(async (req, res) => {
  try {
    const reqUrl = new URL(req.url, `http://localhost:${PORT}`);
    if (reqUrl.pathname !== "/oauth2callback") {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    const code = reqUrl.searchParams.get("code");
    const error = reqUrl.searchParams.get("error");

    if (error || !code) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<h2>Authorization failed: ${error || "No code provided"}</h2>`);
      server.close();
      process.exit(1);
    }

    // Exchange code for tokens
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id,
        client_secret,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });

    const tokens = await tokenRes.json();
    if (!tokenRes.ok || !tokens.refresh_token) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(`<h2>Token exchange failed: ${JSON.stringify(tokens.error || "No refresh token")}</h2>`);
      server.close();
      process.exit(1);
    }

    // Write to .env.youtube
    const envContent = [
      `# YouTube Data API Credentials`,
      `YOUTUBE_CLIENT_ID=${client_id}`,
      `YOUTUBE_CLIENT_SECRET=${client_secret}`,
      `YOUTUBE_REFRESH_TOKEN=${tokens.refresh_token}`,
      `YOUTUBE_LIVE_ENABLED=false`,
      "",
    ].join("\n");

    await writeFile(".env.youtube", envContent, "utf8");

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(`<h2>เชื่อมต่อ YouTube กับ AutoPost สำเร็จแล้ว!</h2><p>คุณสามารถปิดหน้านี้ได้เลย</p>`);

    console.log("Successfully obtained YouTube Refresh Token and saved to .env.youtube!");
    server.close();
    process.exit(0);
  } catch (err) {
    console.error("Error processing callback:", err);
    res.writeHead(500);
    res.end("Internal Server Error");
    server.close();
    process.exit(1);
  }
});

server.listen(PORT, () => {
  console.log("Local OAuth server ready at", REDIRECT_URI);
  console.log("Opening browser for YouTube authorization...");
  const cmd = process.platform === "win32" ? "explorer" : "xdg-open";
  spawn(cmd, [authUrl.toString()], { detached: true, stdio: "ignore" }).unref();
});

