import test from "node:test";
import assert from "node:assert/strict";
import { submitProject } from "../src/lib/publishing.ts";
import { HttpError } from "../src/lib/http.ts";

const projectId = "550e8400-e29b-41d4-a716-446655440000";
const submissionKey = "650e8400-e29b-41d4-a716-446655440000";
const postId = "750e8400-e29b-41d4-a716-446655440000";
test("project submission defaults to simulation and forwards stable identity", async () => {
  let args: unknown;
  const result = await submitProject(projectId, { submissionKey }, false, async input => { args = input; return { data: postId, error: null }; });
  assert.deepEqual(args, { p_project_id: projectId, p_submission_key: submissionKey, p_scheduled_at: null, p_execution_mode: "simulation", p_platforms: ["facebook", "youtube", "tiktok"] });
  assert.deepEqual(result, { id: postId, mode: "simulation", published: false });
});
test("live requires both server enablement and explicit user confirmation", async () => {
  let called = false;
  const rpc = async () => { called = true; return { data: postId, error: null }; };
  for (const [enabled, confirmLive] of [[false, false], [false, true], [true, false]]) {
    await assert.rejects(submitProject(projectId, { submissionKey, mode: "live", confirmLive }, enabled, rpc), error => error instanceof HttpError && error.status === 403);
  }
  assert.equal(called, false);
  assert.equal((await submitProject(projectId, { submissionKey, mode: "live", confirmLive: true, expectedUpdatedAt: "2026-11-05T00:00:00Z" }, true, rpc)).mode, "live");
});
test("live preview must have a project version and forwards it for atomic checking", async () => {
  const rpc = async (args: Record<string, unknown>) => { assert.equal(args.p_expected_updated_at, "2026-11-05T00:00:00Z"); return { data: postId, error: null }; };
  await assert.rejects(submitProject(projectId, { submissionKey, mode: "live", confirmLive: true }, true, rpc), error => error instanceof HttpError && error.status === 409);
  await submitProject(projectId, { submissionKey, mode: "live", confirmLive: true, expectedUpdatedAt: "2026-11-05T00:00:00Z" }, true, rpc);
});
test("client cannot inject arbitrary destination, snapshot or credentials", async () => {
  for (const extra of [{ pageId: "other" }, { token: "secret" }, { content_snapshot: {} }]) {
    await assert.rejects(submitProject(projectId, { submissionKey, ...extra }, false, async () => { throw Error("Must not call RPC"); }));
  }
});
test("submission conflicts and permission errors are safe actionable responses", async () => {
  for (const [message, status] of [["Project changed", 409], ["Publication already active", 409], ["Delivery reconciliation required", 409], ["Submission key conflict", 409], ["Workspace access denied", 403], ["Media must be ready and owned", 403], ["Facebook destination not enabled", 503], ["Facebook live publishing not enabled", 403], ["database internal error", 502]] as const) {
    await assert.rejects(submitProject(projectId, { submissionKey }, false, async () => ({ data: null, error: { message } })), error => error instanceof HttpError && error.status === status && !error.message.includes("database internal"));
  }
});
test("scheduled replay forwards original timestamp instead of enforcing future at replay time", async () => {
  const scheduledAt = "2026-01-01T00:00:00Z";
  await submitProject(projectId, { submissionKey, scheduledAt }, false, async args => {
    assert.equal(args.p_scheduled_at, scheduledAt); return { data: postId, error: null };
  });
});
