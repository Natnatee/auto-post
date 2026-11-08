// Server-side credential exchange only. Never publishes posts or logs credentials.
import { readFile, writeFile, unlink, rename } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
const secretPath = join(homedir(), "Downloads", "autopost-meta-exchange-secret-20261105.json");
const userPath = join(homedir(), "Downloads", "autopost-meta-user-20261105.json");
const pageId = "1182106911641987";
const appId = "2034383707224695";
const base = "https://graph.facebook.com/v27.0";
async function graph(path, token) {
  const response = await fetch(`${base}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(30000), redirect: "error" });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(`Graph request failed (code ${data.error?.code ?? response.status}, subcode ${data.error?.error_subcode ?? "none"})`);
  return data;
}
try {
  const secret = JSON.parse(await readFile(secretPath, "utf8"));
  const user = JSON.parse(await readFile(userPath, "utf8"));
  if (secret.appId !== appId || !/^[a-f0-9]{32}$/i.test(secret.appSecret) || !user.userToken) throw new Error("Invalid exchange input");
  const params = new URLSearchParams({ grant_type: "fb_exchange_token", client_id: appId, client_secret: secret.appSecret, fb_exchange_token: user.userToken });
  const exchanged = await graph(`/oauth/access_token?${params}`);
  if (!exchanged.access_token) throw new Error("Missing exchanged User Token");
  const accounts = await graph("/me/accounts?fields=id,name,tasks,access_token&limit=100", exchanged.access_token);
  const page = accounts.data?.find(p => p.id === pageId);
  if (!page?.access_token || !page.tasks?.includes("CREATE_CONTENT")) throw new Error("Expected Page or CREATE_CONTENT task missing");
  const debug = await graph(`/debug_token?${new URLSearchParams({ input_token: page.access_token })}`, `${appId}|${secret.appSecret}`);
  const d = debug.data;
  if (!d?.is_valid || d.app_id !== appId || d.expires_at !== 0) throw new Error("Page Token validation failed or scheduled expiry is not zero");
  const identity = await graph("/me?fields=id,name", page.access_token);
  if (identity.id !== pageId) throw new Error("Page identity mismatch");
  const old = await readFile(".env.facebook", "utf8");
  if (!/^FACEBOOK_PAGE_ACCESS_TOKEN=/m.test(old)) throw new Error("Existing token configuration not found");
  const updated = old.replace(/^FACEBOOK_PAGE_ACCESS_TOKEN=.*$/m, `FACEBOOK_PAGE_ACCESS_TOKEN=${page.access_token}`);
  await writeFile(".env.facebook.exchange-tmp", updated, { mode: 0o600, flag: "wx" });
  await rename(".env.facebook.exchange-tmp", ".env.facebook");
  console.log(JSON.stringify({ page: identity.name, pageId, valid: d.is_valid, type: d.type, expires_at: d.expires_at, data_access_expires_at: d.data_access_expires_at, scopes: d.scopes, user_token_expires_in: exchanged.expires_in, published: false }, null, 2));
} catch (error) {
  console.error(error.message.startsWith("Graph request failed") ? error.message : "Token exchange failed; credentials not printed. Check inputs, network, and Page permissions.");
  process.exitCode = 1;
} finally {
  await Promise.all([secretPath, userPath].map(p => unlink(p).catch(() => {})));
}
