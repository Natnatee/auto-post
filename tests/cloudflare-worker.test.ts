import assert from "node:assert/strict";
import test from "node:test";
import cloudflareWorker, {
  Config,
  Facebook,
  RESPONSE_BYTE_LIMIT,
  Supabase,
  TransportError,
  ValueError,
  Worker,
  validateContent,
  type ConfigInit,
  type FetchLike,
} from "../worker/cloudflare.ts";

function makeConfig(overrides: Partial<ConfigInit> = {}): Config {
  return new Config({
    url: "https://example.supabase.co",
    key: "sb_secret_PRIVATE",
    mode: "live",
    leaseSeconds: 300,
    facebookToken: "PRIVATE_TOKEN",
    facebookPageId: "123",
    facebookVersion: "v27.0",
    facebookLiveEnabled: true,
    ...overrides,
  });
}

function makeAsset(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "asset",
    object_path: "11111111-1111-1111-1111-111111111111/image.png",
    mime_type: "image/png",
    size_bytes: 100,
    role: "cover",
    position: 0,
    ...overrides,
  };
}

function makeTarget(
  mode: "live" | "simulation" = "live",
  assets: Array<Record<string, unknown>> = []
): Record<string, unknown> {
  return {
    id: "target",
    platform: "facebook",
    lease_token: "PRIVATE_LEASE",
    execution_mode: mode,
    content_snapshot: {
      schema_version: 1,
      project_id: "project",
      workspace_id: "workspace",
      title: " Title ",
      description: "Description",
      hashtags: ["sale", "#new"],
      price: 0,
      execution_mode: mode,
      destination: { platform: "facebook", page_id: "123", page_name: "Page" },
      assets,
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

test("Cloudflare worker: feed post, fencing order, and 7 finish fields", async () => {
  const rpcCalls: Array<{ name: string; payload: Record<string, unknown> }> = [];
  let signedUrlCalled = false;
  let fbCalled = 0;

  const transport = {
    async rpc(name: string, payload: Record<string, unknown>) {
      rpcCalls.push({ name, payload });
      if (name === "claim_target") return makeTarget();
      if (name === "begin_target_dispatch") return true;
      return true;
    },
    async signedUrl() {
      signedUrlCalled = true;
      return "https://example.supabase.co/storage/v1/object/sign/social-media/image?token=x";
    },
  };

  const fetcher: FetchLike = async (url, init) => {
    fbCalled += 1;
    assert.ok(url.endsWith("/v27.0/123/feed"));
    assert.equal(init?.redirect, "error");
    assert.equal(
      (init?.headers as Record<string, string>).Authorization,
      "Bearer PRIVATE_TOKEN"
    );
    assert.deepEqual(JSON.parse(String(init?.body)), {
      message:
        "Title\n\nDescription\n\nราคา 0.00 บาท\n\n🌐 ดูเพิ่มเติมได้ที่: https://www.elephant-maker.com/\n\n#sale #new",
    });
    return jsonResponse({ id: "123_456" });
  };

  const cfg = makeConfig();
  const worker = new Worker(cfg, transport, new Facebook(cfg, fetcher));
  assert.equal(await worker.runOnce(), true);
  assert.equal(fbCalled, 1);
  assert.equal(signedUrlCalled, false);
  assert.deepEqual(
    rpcCalls.map((c) => c.name),
    ["claim_target", "begin_target_dispatch", "finish_target"]
  );
  const finish = rpcCalls[2].payload;
  assert.equal(Object.keys(finish).length, 7);
  assert.equal(finish.p_status, "published");
  assert.equal(finish.p_external_post_id, "123_456");
  assert.equal(finish.p_published_url, "https://www.facebook.com/123_456");
  assert.equal(finish.p_delivery_uncertain, false);
});

test("Cloudflare worker: video remote URL and fencing order with companion images", async () => {
  const video = makeAsset({
    mime_type: "video/mp4",
    role: "video",
    size_bytes: 2 * 1024 ** 3,
    object_path: "11111111-1111-1111-1111-111111111111/clip.mp4",
  });
  const cover = makeAsset({ role: "cover" });
  const events: string[] = [];
  const signedVideoUrl =
    "https://example.supabase.co/storage/v1/object/sign/social-media/video?token=PRIVATE";

  const transport = {
    async rpc(name: string, payload: Record<string, unknown>) {
      events.push(name);
      if (name === "claim_target") {
        return makeTarget("live", [cover, video, { ...video, role: "gallery" }]);
      }
      if (name === "finish_target") {
        assert.equal(payload.p_status, "published");
        assert.equal(payload.p_external_post_id, "456");
        assert.equal(payload.p_delivery_uncertain, false);
      }
      return true;
    },
    async signedUrl(path: string) {
      events.push("sign");
      assert.equal(path, video.object_path);
      return signedVideoUrl;
    },
  };

  const fetcher: FetchLike = async (url, init) => {
    events.push("facebook");
    assert.equal(url, "https://graph.facebook.com/v27.0/123/videos");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      file_url: signedVideoUrl,
      description:
        "Title\n\nDescription\n\nราคา 0.00 บาท\n\n🌐 ดูเพิ่มเติมได้ที่: https://www.elephant-maker.com/\n\n#sale #new",
      published: true,
    });
    return jsonResponse({ id: "456" });
  };

  const cfg = makeConfig();
  await new Worker(cfg, transport, new Facebook(cfg, fetcher)).runOnce();
  assert.deepEqual(events, [
    "claim_target",
    "sign",
    "begin_target_dispatch",
    "facebook",
    "finish_target",
  ]);
});

test("Cloudflare worker: media selection per platform (Facebook photo vs video, YouTube/TikTok video)", async () => {
  const video = makeAsset({
    mime_type: "video/mp4",
    role: "video",
    size_bytes: 5 * 1024 * 1024,
    object_path: "11111111-1111-1111-1111-111111111111/video.mp4",
  });
  const cover = makeAsset({
    mime_type: "image/jpeg",
    role: "cover",
    size_bytes: 500 * 1024,
    object_path: "11111111-1111-1111-1111-111111111111/cover.jpg",
  });

  const snapFbPhoto = {
    ...(makeTarget("live", [cover, video]).content_snapshot as Record<string, unknown>),
    facebook_media_type: "photo",
  };
  const fbPhotoResult = validateContent(snapFbPhoto, "facebook");
  assert.equal(fbPhotoResult.path, cover.object_path);

  const snapFbVideo = {
    ...(makeTarget("live", [cover, video]).content_snapshot as Record<string, unknown>),
    facebook_media_type: "video",
  };
  const fbVideoResult = validateContent(snapFbVideo, "facebook");
  assert.equal(fbVideoResult.path, video.object_path);

  const ytResult = validateContent(snapFbPhoto, "youtube");
  assert.equal(ytResult.path, video.object_path);

  const ttResult = validateContent(snapFbPhoto, "tiktok");
  assert.equal(ttResult.path, video.object_path);
});

test("Cloudflare worker: closed gates, simulation isolation, and error classification", async () => {
  for (const overrides of [
    { facebookLiveEnabled: false },
    { facebookToken: "" },
    { leaseSeconds: 119 },
    { facebookPageId: "456" },
    { mode: "simulation" as const },
  ]) {
    let finishedStatus = "";
    const transport = {
      async rpc(name: string, payload: Record<string, unknown>) {
        if (name === "claim_target") return makeTarget("live", [makeAsset()]);
        if (name === "finish_target") finishedStatus = String(payload.p_status);
        return true;
      },
      async signedUrl() {
        throw new Error("Should not sign when live gates are closed");
      },
    };
    const cfg = makeConfig(overrides);
    await new Worker(cfg, transport, {
      async publish() {
        throw new Error("Should not call Facebook when gates closed");
      },
    }).runOnce();
    assert.equal(finishedStatus, "blocked");
  }

  // Definitive 400 error vs transient/500 uncertain error
  const cfg = makeConfig();
  const definitive = await new Facebook(cfg, async () =>
    jsonResponse({ error: { code: 190, message: "PRIVATE_TOKEN" } }, 400)
  ).publish("caption");
  assert.equal(definitive.status, "failed");
  assert.equal(definitive.delivery_uncertain, false);
  assert.ok(!definitive.error?.includes("PRIVATE_TOKEN"));

  const transient = await new Facebook(cfg, async () =>
    jsonResponse({ error: { code: 100, is_transient: true } }, 400)
  ).publish("caption");
  assert.equal(transient.status, "blocked");
  assert.equal(transient.delivery_uncertain, true);

  const serverErr = await new Facebook(cfg, async () =>
    jsonResponse({ error: { code: 100 } }, 500)
  ).publish("caption");
  assert.equal(serverErr.status, "blocked");
  assert.equal(serverErr.delivery_uncertain, true);
});

test("Cloudflare worker: Supabase transport bounds, headers, and signedUrl origin checks", async () => {
  let seenHeaders: Record<string, string> = {};
  const sbModern = new Supabase(makeConfig({ key: "sb_secret_NEW" }), async (_u, init) => {
    seenHeaders = init?.headers as Record<string, string>;
    return jsonResponse(null);
  });
  await sbModern.rpc("claim_target", {});
  assert.equal(seenHeaders.apikey, "sb_secret_NEW");
  assert.equal(seenHeaders.Authorization, undefined);

  const sbLegacy = new Supabase(
    makeConfig({ key: "eyJ.payload.signature" }),
    async (_u, init) => {
      seenHeaders = init?.headers as Record<string, string>;
      return jsonResponse(null);
    }
  );
  await sbLegacy.rpc("claim_target", {});
  assert.equal(seenHeaders.Authorization, "Bearer eyJ.payload.signature");

  for (const good of [
    "/object/sign/social-media/image?token=x",
    "/storage/v1/object/sign/social-media/image?token=x",
    "https://example.supabase.co/storage/v1/object/sign/social-media/image?token=x",
  ]) {
    const sb = new Supabase(makeConfig(), async () =>
      jsonResponse({ signedURL: good })
    );
    const signed = await sb.signedUrl(String(makeAsset().object_path));
    assert.ok(
      signed.startsWith("https://example.supabase.co/storage/v1/object/sign/social-media/")
    );
  }

  for (const bad of [
    "https://evil.test/x",
    "//evil.test/x",
    "https://example.supabase.co@evil.test/x",
    "/wrong",
  ]) {
    const sb = new Supabase(makeConfig(), async () =>
      jsonResponse({ signedUrl: bad })
    );
    await assert.rejects(() => sb.signedUrl(String(makeAsset().object_path)), TransportError);
  }

  // Oversized response is rejected
  const oversized = new Uint8Array(RESPONSE_BYTE_LIMIT + 2).fill(65);
  const sbOversized = new Supabase(
    makeConfig(),
    async () => new Response(oversized, { status: 200 })
  );
  await assert.rejects(() => sbOversized.rpc("claim_target", {}), TransportError);
});

test("Cloudflare worker: validateContent price, path security, and fetch/scheduled handlers", async () => {
  for (const badPrice of ["NaN", "Infinity", -1, true]) {
    const snap = makeTarget().content_snapshot as Record<string, unknown>;
    snap.price = badPrice;
    assert.throws(() => validateContent(snap), ValueError);
  }

  const res = await cloudflareWorker.fetch();
  assert.equal(res.status, 404);
  assert.equal(res.headers.get("Cache-Control"), "no-store");

  // scheduled with invalid env does not throw
  await cloudflareWorker.scheduled({}, {});
});

