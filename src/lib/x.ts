/**
 * X (Twitter) Publishing Adapter for Auto-post.
 * Implements HMAC-SHA1 OAuth 1.0a signing and X API v2 Tweet Creation (`POST /2/tweets`).
 * Zero external heavy dependencies - uses native Node/Web Crypto.
 */
import { createHmac, randomBytes } from "node:crypto";

export interface XConfig {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
  liveEnabled?: boolean;
}

export interface XTweetMetadata {
  text: string;
  mediaIds?: string[];
}

export interface XPublishResult {
  status: "published" | "simulated" | "failed" | "blocked";
  error: string | null;
  tweetId: string | null;
  publishedUrl: string | null;
  deliveryUncertain: boolean;
}

export function percentEncode(str: string): string {
  return encodeURIComponent(str)
    .replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

export function generateOAuth1Header(
  method: string,
  url: string,
  params: Record<string, string>,
  consumerKey: string,
  consumerSecret: string,
  token: string,
  tokenSecret: string
): string {
  const oauthParams: Record<string, string> = {
    oauth_consumer_key: consumerKey,
    oauth_nonce: randomBytes(16).toString("hex"),
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_token: token,
    oauth_version: "1.0",
    ...params,
  };

  const sortedKeys = Object.keys(oauthParams).sort();
  const paramString = sortedKeys
    .map((k) => `${percentEncode(k)}=${percentEncode(oauthParams[k])}`)
    .join("&");

  const baseString = [
    method.toUpperCase(),
    percentEncode(url),
    percentEncode(paramString),
  ].join("&");

  const signingKey = `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
  const signature = createHmac("sha1", signingKey).update(baseString).digest("base64");

  oauthParams.oauth_signature = signature;

  const headerKeys = Object.keys(oauthParams)
    .filter((k) => k.startsWith("oauth_"))
    .sort();

  return "OAuth " + headerKeys.map((k) => `${percentEncode(k)}="${percentEncode(oauthParams[k])}"`).join(", ");
}

export class XAdapter {
  readonly config: XConfig;
  readonly fetcher: typeof fetch;

  constructor(config: XConfig, fetcher: typeof fetch = fetch) {
    this.config = config;
    this.fetcher = (input: any, init?: any) => fetcher(input, init);
  }

  /**
   * Post a tweet using X API v2 (POST https://api.x.com/2/tweets)
   */
  async postTweet(
    metadata: XTweetMetadata,
    mode: "live" | "simulation" = "simulation"
  ): Promise<XPublishResult> {
    if (mode === "simulation") {
      return {
        status: "simulated",
        error: null,
        tweetId: null,
        publishedUrl: null,
        deliveryUncertain: false,
      };
    }

    if (!this.config.liveEnabled) {
      return {
        status: "blocked",
        error: "X live publishing is disabled by safety gate",
        tweetId: null,
        publishedUrl: null,
        deliveryUncertain: false,
      };
    }

    const url = "https://api.x.com/2/tweets";
    const authHeader = generateOAuth1Header(
      "POST",
      url,
      {},
      this.config.apiKey,
      this.config.apiSecret,
      this.config.accessToken,
      this.config.accessSecret
    );

    const body: Record<string, unknown> = {
      text: metadata.text.slice(0, 280),
    };

    if (metadata.mediaIds && metadata.mediaIds.length > 0) {
      body.media = { media_ids: metadata.mediaIds };
    }

    try {
      const res = await this.fetcher(url, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });

      const json = (await res.json()) as {
        data?: { id: string; text: string };
        errors?: Array<{ message: string }>;
        detail?: string;
      };

      if (!res.ok || !json.data?.id) {
        const errorMsg = json.errors?.[0]?.message || json.detail || `HTTP ${res.status}`;
        return {
          status: "failed",
          error: `X API error: ${errorMsg}`,
          tweetId: null,
          publishedUrl: null,
          deliveryUncertain: false,
        };
      }

      const tweetId = json.data.id;
      return {
        status: "published",
        error: null,
        tweetId,
        publishedUrl: `https://x.com/i/status/${tweetId}`,
        deliveryUncertain: false,
      };
    } catch (err: any) {
      return {
        status: "blocked",
        error: `X publish network error: ${err.message}`,
        tweetId: null,
        publishedUrl: null,
        deliveryUncertain: true,
      };
    }
  }
}

