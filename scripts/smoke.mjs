import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

const origin = "http://127.0.0.1:3107";
const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "--hostname", "127.0.0.1", "--port", "3107"], {
  env: { ...process.env, SUPABASE_URL: "", SUPABASE_PUBLISHABLE_KEY: "", APP_ORIGIN: origin, NEXT_TELEMETRY_DISABLED: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let logs = "";
child.stdout.on("data", data => { logs += data; });
child.stderr.on("data", data => { logs += data; });
try {
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (child.exitCode !== null) throw new Error("Next server exited: " + logs);
    try { const response = await fetch(origin + "/api/dashboard"); ready = response.ok; } catch { /* bounded startup wait */ }
    if (ready) break;
    await delay(500);
  }
  assert.ok(ready, "Server must start within 30 seconds");
  const home = await fetch(origin);
  assert.equal(home.status, 200);
  assert.match(await home.text(), /autopost|Autopost/);
  const dashboard = await fetch(origin + "/api/dashboard");
  assert.equal(dashboard.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await dashboard.json(), { configured: false, authenticated: false, owner: false, demo: true, simulation: true });
  const crossSite = await fetch(origin + "/api/auth/login", { method: "POST", headers: { Origin: "https://attacker.invalid", "Content-Type": "application/json" }, body: "{}" });
  assert.equal(crossSite.status, 403);
  const unconfigured = await fetch(origin + "/api/posts", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}" });
  assert.equal(unconfigured.status, 503);
  console.log("HTTP smoke passed: page, explicit preview, private cache headers, CSRF rejection, unconfigured writes disabled.");
} finally {
  child.kill("SIGTERM");
  await Promise.race([new Promise(resolve => child.once("exit", resolve)), delay(5000)]);
  if (child.exitCode === null) child.kill("SIGKILL");
}
