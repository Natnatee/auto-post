import { database } from "./cloud-db.mjs";

const targetId = "3c08c44f-fc92-4b3b-a357-294663c3aaa8";
const db = database();
await db.connect();

const target = (await db.query("SELECT * FROM public.post_targets WHERE id = $1", [targetId])).rows[0];
console.log("Current target status:", target.platform, target.status, target.error);

await db.query(`
  UPDATE public.post_targets
  SET status = 'pending', attempts = 0, error = null, lease_token = null, lease_expires_at = null, dispatch_started_at = null, delivery_uncertain = false
  WHERE id = $1
`, [targetId]);

await db.query(`
  UPDATE public.posts
  SET status = 'queued'
  WHERE id = $1
`, [target.post_id]);

console.log("Reset target to pending!");
await db.end();

// Now trigger Cloudflare Worker /run
console.log("Triggering Cloudflare Worker /run...");
const res = await fetch("https://auto-post-worker.drawnewtrio.workers.dev/run", { method: "POST" });
const text = await res.text();
console.log("Worker /run response:", res.status, text);

