import assert from "node:assert/strict";
import test from "node:test";
import { TikTokAdapter } from "../src/lib/tiktok.ts";

test("TikTok Adapter: simulation mode returns simulated without network calls", async () => {
  let called = false;
  const mockFetch: typeof fetch = (async () => {
    called = true;
    return new Response();
  }) as any;

  const adapter = new TikTokAdapter(
    {
      clientKey: "key",
      clientSecret: "secret",
      redirectUri: "https://example.com/callback",
      liveEnabled: false,
    },
    mockFetch
  );

  const res = await adapter.publishFromUrl(
    "https://example.com/video.mp4",
    { title: "Test video" },
    "simulation"
  );

  assert.equal(res.status, "simulated");
  assert.equal(res.publishId, null);
  assert.equal(called, false);
});

test("TikTok Adapter: blocks live when liveEnabled is false", async () => {
  const adapter = new TikTokAdapter({
    clientKey: "key",
    clientSecret: "secret",
    redirectUri: "https://example.com/callback",
    liveEnabled: false,
  });

  const res = await adapter.publishFromUrl(
    "https://example.com/video.mp4",
    { title: "Live Test" },
    "live"
  );

  assert.equal(res.status, "blocked");
  assert.match(res.error || "", /disabled by safety gate/);
});

test("TikTok Adapter: full direct post flow", async () => {
  const calls: string[] = [];
  const mockFetch: typeof fetch = (async (url: string, init?: RequestInit) => {
    const urlStr = url.toString();
    if (urlStr === "https://storage.example.com/video.mp4" && init?.method === "HEAD") {
      calls.push("HEAD_storage");
      return new Response(null, {
        headers: { "Content-Length": "2097152" },
      });
    }

    if (urlStr.includes("/v2/post/publish/video/init/")) {
      calls.push("INIT_post");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.source_info.video_size, 2097152);
      assert.equal(body.post_info.title, "My TikTok Viral Clip");
      return new Response(
        JSON.stringify({
          data: {
            publish_id: "v_pub_789456",
            upload_url: "https://upload.tiktok.com/chunk_upload_xyz",
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      );
    }

    if (urlStr === "https://storage.example.com/video.mp4") {
      calls.push("GET_storage");
      return new Response(new Uint8Array(2097152), { status: 200 });
    }

    if (urlStr === "https://upload.tiktok.com/chunk_upload_xyz" && init?.method === "PUT") {
      calls.push("PUT_bytes");
      assert.equal(init?.headers && (init.headers as any)["Content-Length"], "2097152");
      return new Response(null, { status: 200 });
    }

    throw new Error(`Unexpected request to: ${urlStr}`);
  }) as any;

  const adapter = new TikTokAdapter(
    {
      clientKey: "key",
      clientSecret: "secret",
      redirectUri: "https://example.com/callback",
      accessToken: "mock_tiktok_access_token",
      liveEnabled: true,
    },
    mockFetch
  );

  const res = await adapter.publishFromUrl(
    "https://storage.example.com/video.mp4",
    {
      title: "My TikTok Viral Clip",
      privacyLevel: "PUBLIC_TO_EVERYONE",
    },
    "live"
  );

  assert.equal(res.status, "published");
  assert.equal(res.publishId, "v_pub_789456");
  assert.equal(res.publishedUrl, "https://www.tiktok.com/publish/v_pub_789456");
  assert.deepEqual(calls, [
    "HEAD_storage",
    "INIT_post",
    "GET_storage",
    "PUT_bytes",
  ]);
});

