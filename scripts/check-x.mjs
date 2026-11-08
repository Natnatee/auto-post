// Read-only connection check with X API v2 (GET /2/users/me).
// Does NOT publish any tweets.
process.loadEnvFile(".env.x");
import { generateOAuth1Header } from "../src/lib/x.ts";

const apiKey = process.env.X_API_KEY;
const apiSecret = process.env.X_API_SECRET;
const accessToken = process.env.X_ACCESS_TOKEN;
const accessSecret = process.env.X_ACCESS_SECRET;

if (!apiKey || !apiSecret || !accessToken || !accessSecret) {
  console.error("Missing X API configuration in .env.x");
  process.exit(1);
}

const url = "https://api.x.com/2/users/me";
const authHeader = generateOAuth1Header(
  "GET",
  url,
  {},
  apiKey,
  apiSecret,
  accessToken,
  accessSecret
);

try {
  const res = await fetch(url, {
    method: "GET",
    headers: { Authorization: authHeader },
    signal: AbortSignal.timeout(15_000),
  });

  const json = await res.json();
  if (res.ok && json.data) {
    console.log(`X User verified: "${json.data.name}" (@${json.data.username}) - ID: ${json.data.id}`);
    console.log("Read-only validation passed. X connection is active and ready!");
  } else {
    console.error("X API check failed:", json);
    process.exit(1);
  }
} catch (err) {
  console.error("Network or verification error:", err.message);
  process.exit(1);
}

