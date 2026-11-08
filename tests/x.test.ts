import assert from "node:assert/strict";
import test from "node:test";
import { XAdapter, generateOAuth1Header, percentEncode } from "../src/lib/x.ts";

test("X Adapter: percentEncode escapes RFC 3986 reserved characters", () => {
  assert.equal(percentEncode("hello world!"), "hello%20world%21");
  assert.equal(percentEncode("foo(bar)*"), "foo%28bar%29%2A");
});

test("X Adapter: generateOAuth1Header produces valid header format", () => {
  const header = generateOAuth1Header(
    "POST",
    "https://api.x.com/2/tweets",
    {},
    "CONSUMER_KEY",
    "CONSUMER_SECRET",
    "TOKEN",
    "TOKEN_SECRET"
  );

  assert.ok(header.startsWith("OAuth "));
  assert.ok(header.includes('oauth_consumer_key="CONSUMER_KEY"'));
  assert.ok(header.includes('oauth_signature_method="HMAC-SHA1"'));
  assert.ok(header.includes('oauth_token="TOKEN"'));
  assert.ok(header.includes("oauth_signature="));
});

test("X Adapter: simulation mode returns simulated without network calls", async () => {
  let called = false;
  const mockFetch: typeof fetch = (async () => {
    called = true;
    return new Response();
  }) as any;

  const adapter = new XAdapter(
    {
      apiKey: "k",
      apiSecret: "s",
      accessToken: "t",
      accessSecret: "ts",
      liveEnabled: false,
    },
    mockFetch
  );

  const res = await adapter.postTweet({ text: "Hello X" }, "simulation");
  assert.equal(res.status, "simulated");
  assert.equal(res.tweetId, null);
  assert.equal(called, false);
});

test("X Adapter: blocks live when liveEnabled is false", async () => {
  const adapter = new XAdapter({
    apiKey: "k",
    apiSecret: "s",
    accessToken: "t",
    accessSecret: "ts",
    liveEnabled: false,
  });

  const res = await adapter.postTweet({ text: "Live test" }, "live");
  assert.equal(res.status, "blocked");
  assert.match(res.error || "", /disabled by safety gate/);
});

test("X Adapter: posts tweet via X API v2 successfully", async () => {
  const mockFetch: typeof fetch = (async (url: string, init?: RequestInit) => {
    assert.equal(url.toString(), "https://api.x.com/2/tweets");
    assert.equal(init?.method, "POST");
    const auth = init?.headers && (init.headers as any).Authorization;
    assert.ok(auth.startsWith("OAuth "));
    const body = JSON.parse(String(init?.body));
    assert.equal(body.text, "Hello from AutoPost!");
    return new Response(
      JSON.stringify({
        data: {
          id: "1987654321098765432",
          text: "Hello from AutoPost!",
        },
      }),
      { status: 201, headers: { "Content-Type": "application/json" } }
    );
  }) as any;

  const adapter = new XAdapter(
    {
      apiKey: "k",
      apiSecret: "s",
      accessToken: "t",
      accessSecret: "ts",
      liveEnabled: true,
    },
    mockFetch
  );

  const res = await adapter.postTweet({ text: "Hello from AutoPost!" }, "live");
  assert.equal(res.status, "published");
  assert.equal(res.tweetId, "1987654321098765432");
  assert.equal(res.publishedUrl, "https://x.com/i/status/1987654321098765432");
});

