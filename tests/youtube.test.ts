import assert from "node:assert/strict";
import test from "node:test";
import { YouTubeAdapter } from "../src/lib/youtube.ts";

test("YouTube Adapter: simulation mode returns simulated without network calls", async () => {
  let called = false;
  const mockFetch: typeof fetch = (async () => {
    called = true;
    return new Response();
  }) as any;

  const adapter = new YouTubeAdapter(
    {
      clientId: "cid",
      clientSecret: "csec",
      refreshToken: "rtok",
      liveEnabled: false,
    },
    mockFetch
  );

  const res = await adapter.publishFromUrl(
    "https://example.com/video.mp4",
    { title: "Test", description: "Desc" },
    "simulation"
  );

  assert.equal(res.status, "simulated");
  assert.equal(res.videoId, null);
  assert.equal(called, false);
});

test("YouTube Adapter: blocks live when liveEnabled is false", async () => {
  const adapter = new YouTubeAdapter({
    clientId: "cid",
    clientSecret: "csec",
    refreshToken: "rtok",
    liveEnabled: false,
  });

  const res = await adapter.publishFromUrl(
    "https://example.com/video.mp4",
    { title: "Live Test", description: "Desc" },
    "live"
  );

  assert.equal(res.status, "blocked");
  assert.match(res.error || "", /disabled by safety gate/);
});

test("YouTube Adapter: full resumable upload flow", async () => {
  const calls: string[] = [];
  const mockFetch: typeof fetch = (async (url: string, init?: RequestInit) => {
    const urlStr = url.toString();
    if (urlStr === "https://storage.example.com/video.mp4" && init?.method === "HEAD") {
      calls.push("HEAD_storage");
      return new Response(null, {
        headers: { "Content-Length": "1048576" },
      });
    }

    if (urlStr === "https://oauth2.googleapis.com/token") {
      calls.push("OAUTH_token");
      return new Response(JSON.stringify({ access_token: "mock_access_token" }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (urlStr.includes("upload.youtube.com") || urlStr.includes("googleapis.com/upload")) {
      if (init?.method === "POST") {
        calls.push("CREATE_session");
        return new Response(null, {
          status: 200,
          headers: { Location: "https://upload.youtube.com/session_upload_123" },
        });
      }
    }

    if (urlStr === "https://storage.example.com/video.mp4") {
      calls.push("GET_storage");
      return new Response(new Uint8Array(1048576), { status: 200 });
    }

    if (urlStr === "https://upload.youtube.com/session_upload_123" && init?.method === "PUT") {
      calls.push("PUT_bytes");
      assert.equal(init?.headers && (init.headers as any)["Content-Length"], "1048576");
      return new Response(JSON.stringify({ id: "yt_video_abc123" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    throw new Error(`Unexpected request to: ${urlStr}`);
  }) as any;

  const adapter = new YouTubeAdapter(
    {
      clientId: "cid",
      clientSecret: "csec",
      refreshToken: "rtok",
      liveEnabled: true,
    },
    mockFetch
  );

  const res = await adapter.publishFromUrl(
    "https://storage.example.com/video.mp4",
    {
      title: "My Amazing Video",
      description: "Check out this video #Shorts",
      tags: ["tech", "shorts"],
      privacyStatus: "unlisted",
    },
    "live"
  );

  assert.equal(res.status, "published");
  assert.equal(res.videoId, "yt_video_abc123");
  assert.equal(res.publishedUrl, "https://www.youtube.com/watch?v=yt_video_abc123");
  assert.deepEqual(calls, [
    "HEAD_storage",
    "OAUTH_token",
    "CREATE_session",
    "GET_storage",
    "PUT_bytes",
  ]);
});

