// Read-only connection check. Does not create, update or delete any Facebook post.
process.loadEnvFile(".env.facebook");
const token = process.env.FACEBOOK_PAGE_ACCESS_TOKEN;
const id = process.env.FACEBOOK_PAGE_ID;
const version = process.env.FACEBOOK_GRAPH_VERSION;
if (!token || !id || !/^v\d+\.\d+$/.test(version || "")) {
  console.error("Missing or invalid Facebook server configuration");
  process.exitCode = 1;
} else {
  try {
    const response = await fetch(`https://graph.facebook.com/${version}/me?fields=id,name`, {
      headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
    });
    const data = await response.json();
    if (!response.ok || data.id !== id) {
      console.error("Facebook connection failed; reconnect or check Page token. Graph error code:", data.error?.code || response.status, "subcode:", data.error?.error_subcode || "none", "expired:", /expired/i.test(data.error?.message || ""));
      process.exitCode = 1;
    } else {
      console.log(`Facebook Page verified: ${data.name} (${data.id})`);
      console.log("Read-only validation passed. No posts published; token lifetime not verified.");
    }
  } catch {
    console.error("Facebook check failed: network timeout or invalid response");
    process.exitCode = 1;
  }
}
