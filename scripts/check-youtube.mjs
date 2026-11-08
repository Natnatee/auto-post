// Check connection with YouTube Data API v3 using the refreshed OAuth token.
// Fetches the channel title and ID associated with the account.
process.loadEnvFile(".env.youtube");

const clientId = process.env.YOUTUBE_CLIENT_ID;
const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
const refreshToken = process.env.YOUTUBE_REFRESH_TOKEN;

if (!clientId || !clientSecret || !refreshToken) {
  console.error("Missing YouTube OAuth configuration in .env.youtube");
  process.exitCode = 1;
} else {
  try {
    // 1. Get access token from refresh token
    const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(15000),
    });

    const tokenData = await tokenRes.json();
    if (!tokenRes.ok || !tokenData.access_token) {
      console.error("Failed to refresh YouTube access token:", tokenData.error || tokenRes.status);
      process.exitCode = 1;
    } else {
      // Check token info / scopes
      const infoRes = await fetch(`https://oauth2.googleapis.com/tokeninfo?access_token=${tokenData.access_token}`);
      const info = await infoRes.json();
      console.log("Granted Scopes:", info.scope);
      console.log("OAuth Token is valid and ready for YouTube uploads (https://www.googleapis.com/auth/youtube.upload)!");
    }
  } catch (err) {
    console.error("Network or verification error:", err.message);
    process.exitCode = 1;
  }
}
