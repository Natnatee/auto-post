import test from "node:test";
import assert from "node:assert/strict";
import { contentProjectSchema, postSchema, uploadSchema } from "../src/lib/validation.ts";
import { assertOrigin, readJson } from "../src/lib/http.ts";
const post = { title: "ทดสอบ", hashtags: ["test"], platforms: ["facebook"], mediaIds: ["550e8400-e29b-41d4-a716-446655440000"], scheduledAt: "2026-12-01T10:00:00+07:00" };
test("accept Thai schedule, owned media IDs and supported targets", () => assert.equal(postSchema.parse(post).title, "ทดสอบ"));
test("description is optional, bounded and preserved for publication", () => {
  assert.equal(postSchema.parse(post).description, "");
  assert.equal(postSchema.parse({ ...post, description: "รายละเอียดโพสต์" }).description, "รายละเอียดโพสต์");
  assert.equal(postSchema.safeParse({ ...post, description: "x".repeat(5001) }).success, false);
});
test("reject empty media, duplicate targets and oversized title", () => {
  for (const override of [{ mediaIds: [] }, { platforms: ["x", "x"] }, { title: "a".repeat(501) }]) assert.equal(postSchema.safeParse({ ...post, ...override }).success, false);
});
test("reject unsafe types, empty and oversized media", () => {
  for (const override of [{ mimeType: "text/html" }, { sizeBytes: 0 }, { sizeBytes: 2147483649 }]) assert.equal(uploadSchema.safeParse({ filename: "clip.mp4", mimeType: "video/mp4", sizeBytes: 500, ...override }).success, false);
});
test("content drafts and asset roles validated independently of publishing", () => {
  const base = { title: "Project", hashtags: [], assets: [] };
  assert.equal(contentProjectSchema.safeParse(base).success, true);
  const id = "550e8400-e29b-41d4-a716-446655440000";
  const assets = [{ media_id: id, role: "cover", position: 0 }, { media_id: id, role: "gallery", position: 0 }];
  assert.equal(contentProjectSchema.safeParse({ ...base, assets }).success, true);
    assert.equal(contentProjectSchema.safeParse({ ...base, assets: [assets[1], { ...assets[1], position: 1 }] }).success, false);
  assert.equal(contentProjectSchema.safeParse({ ...base, assets: [{ media_id: id, role: "invalid", position: 0 }] }).success, false);
});
test("optional selling price allows zero and two decimal baht only", () => {
  const base = { title: "Product", hashtags: [], assets: [] };
  assert.equal(contentProjectSchema.parse(base).price, null);
  for (const price of [null, 0, 199.99, 9999999999.99]) assert.equal(contentProjectSchema.parse({ ...base, price }).price, price);
  for (const price of [-1, 1.234, Infinity, 10000000000, "199"]) assert.equal(contentProjectSchema.safeParse({ ...base, price }).success, false);
});
test("Origin must match configured public URL, not incoming host", () => {
  assert.doesNotThrow(() => assertOrigin(new Request("https://private.example/api", { headers: { Origin: "https://private.example" } }), "https://private.example"));
  assert.throws(() => assertOrigin(new Request("https://private.example/api", { headers: { Origin: "https://attacker.example" } }), "https://private.example"));
  assert.throws(() => assertOrigin(new Request("https://private.example/api"), "https://private.example"));
});
test("only bounded JSON accepted, not media payloads", async () => {
  await assert.rejects(readJson(new Request("http://localhost", { method: "POST", headers: { "Content-Type": "video/mp4" }, body: "data" })));
  await assert.rejects(readJson(new Request("http://localhost", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: "x".repeat(65536) }) })));
  assert.deepEqual(await readJson(new Request("http://localhost", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{\"ok\":true}" })), { ok: true });
});
