/**
 * Cloudflare Worker publisher for Auto-post.
 * Preserves all lease fencing, live gates, and remote-URL media rules from worker/main.py.
 */

import { YouTubeAdapter } from "../src/lib/youtube";
import { TikTokAdapter } from "../src/lib/tiktok";
import { XAdapter } from "../src/lib/x";

export const RESPONSE_BYTE_LIMIT = 1_048_576;

const DEFINITIVE_GRAPH_CODES = new Set([10, 100, 102, 190, 200, 2500]);
const UUID_REGEX =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/i;

export class TransportError extends Error {
  constructor(message = "Transport request failed") {
    super(message);
    this.name = "TransportError";
  }
}

export interface WorkerEnv {
  SUPABASE_URL?: string;
  SUPABASE_SECRET_KEY?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  WORKER_MODE?: string;
  LEASE_SECONDS?: string;
  FACEBOOK_PAGE_ACCESS_TOKEN?: string;
  FACEBOOK_PAGE_ID?: string;
  FACEBOOK_GRAPH_VERSION?: string;
  FACEBOOK_LIVE_ENABLED?: string;
  YOUTUBE_CLIENT_ID?: string;
  YOUTUBE_CLIENT_SECRET?: string;
  YOUTUBE_REFRESH_TOKEN?: string;
  YOUTUBE_LIVE_ENABLED?: string;
  YOUTUBE_PRIVACY_STATUS?: string;
  TIKTOK_CLIENT_KEY?: string;
  TIKTOK_CLIENT_SECRET?: string;
  TIKTOK_ACCESS_TOKEN?: string;
  TIKTOK_REFRESH_TOKEN?: string;
  TIKTOK_LIVE_ENABLED?: string;
  TIKTOK_PRIVACY_LEVEL?: string;
  X_API_KEY?: string;
  X_API_SECRET?: string;
  X_ACCESS_TOKEN?: string;
  X_ACCESS_SECRET?: string;
  X_LIVE_ENABLED?: string;
  MAX_TARGETS_PER_RUN?: string;
}

export interface PublishResult {
  status: "published" | "simulated" | "failed" | "blocked";
  error: string | null;
  external_post_id: string | null;
  published_url: string | null;
  delivery_uncertain: boolean;
}

export function result(
  status: PublishResult["status"],
  error: string | null = null,
  options?: {
    external_post_id?: string | null;
    published_url?: string | null;
    delivery_uncertain?: boolean;
  }
): PublishResult {
  return {
    status,
    error,
    external_post_id: options?.external_post_id ?? null,
    published_url: options?.published_url ?? null,
    delivery_uncertain: options?.delivery_uncertain ?? false,
  };
}

export async function readBoundedJson(response: Response): Promise<unknown> {
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > RESPONSE_BYTE_LIMIT) {
      throw new Error("Response too large");
    }
    return JSON.parse(text);
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > RESPONSE_BYTE_LIMIT) {
          throw new Error("Response too large");
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(merged);
  return JSON.parse(text);
}

export interface ConfigInit {
  url: string;
  key: string;
  mode?: string;
  leaseSeconds?: number;
  facebookToken?: string;
  facebookPageId?: string;
  facebookVersion?: string;
  facebookLiveEnabled?: boolean;
}

export class Config {
  readonly url: string;
  readonly #key: string;
  readonly mode: "simulation" | "live";
  readonly leaseSeconds: number;
  readonly #facebookToken: string;
  readonly facebookPageId: string;
  readonly facebookVersion: string;
  readonly facebookLiveEnabled: boolean;

  constructor(init: ConfigInit) {
    let parsed: URL;
    try {
      parsed = new URL(init.url);
    } catch {
      throw new ValueError("HTTPS Supabase origin and secret key required");
    }
    if (
      parsed.protocol !== "https:" ||
      !parsed.hostname ||
      parsed.username ||
      parsed.password ||
      (parsed.pathname !== "/" && parsed.pathname !== "") ||
      parsed.search ||
      parsed.hash ||
      !init.key ||
      typeof init.key !== "string"
    ) {
      throw new ValueError("HTTPS Supabase origin and secret key required");
    }
    const mode = init.mode ?? "simulation";
    if (mode !== "simulation" && mode !== "live") {
      throw new ValueError("Invalid worker mode");
    }
    const leaseSeconds = init.leaseSeconds ?? 300;
    if (
      typeof leaseSeconds !== "number" ||
      !Number.isInteger(leaseSeconds) ||
      leaseSeconds < 10 ||
      leaseSeconds > 3600
    ) {
      throw new ValueError("Invalid poll or lease interval");
    }
    const facebookVersion = init.facebookVersion ?? "v27.0";
    if (!/^v\d+\.\d+$/.test(facebookVersion)) {
      throw new ValueError("Invalid Facebook version");
    }

    this.url = init.url.replace(/\/+$/, "");
    this.#key = init.key;
    this.mode = mode;
    this.leaseSeconds = leaseSeconds;
    this.#facebookToken = init.facebookToken ?? "";
    this.facebookPageId = init.facebookPageId ?? "";
    this.facebookVersion = facebookVersion;
    this.facebookLiveEnabled = init.facebookLiveEnabled === true;
  }

  get key(): string {
    return this.#key;
  }

  get facebookToken(): string {
    return this.#facebookToken;
  }

  toJSON(): Record<string, unknown> {
    return {
      url: this.url,
      mode: this.mode,
      leaseSeconds: this.leaseSeconds,
      facebookPageId: this.facebookPageId,
      facebookVersion: this.facebookVersion,
      facebookLiveEnabled: this.facebookLiveEnabled,
    };
  }

  toString(): string {
    return `Config(url=${this.url}, mode=${this.mode}, leaseSeconds=${this.leaseSeconds}, facebookPageId=${this.facebookPageId}, facebookVersion=${this.facebookVersion}, facebookLiveEnabled=${this.facebookLiveEnabled})`;
  }

  static fromEnv(env: WorkerEnv): Config {
    const rawLease = env.LEASE_SECONDS ?? "300";
    if (!/^\d+$/.test(String(rawLease).trim())) {
      throw new ValueError("Invalid poll or lease interval");
    }
    return new Config({
      url: (env.SUPABASE_URL ?? "").replace(/\/+$/, ""),
      key: env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || "",
      mode: env.WORKER_MODE ?? "simulation",
      leaseSeconds: Number.parseInt(String(rawLease).trim(), 10),
      facebookToken: env.FACEBOOK_PAGE_ACCESS_TOKEN ?? "",
      facebookPageId: env.FACEBOOK_PAGE_ID ?? "",
      facebookVersion: env.FACEBOOK_GRAPH_VERSION ?? "v27.0",
      facebookLiveEnabled: env.FACEBOOK_LIVE_ENABLED === "true",
    });
  }
}

export class ValueError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValueError";
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export class Supabase {
  readonly config: Config;
  readonly fetcher: FetchLike;

  constructor(config: Config, fetcher: FetchLike = fetch) {
    this.config = config;
    this.fetcher = (input, init) => fetcher(input, init);
  }

  async post(path: string, payload: unknown): Promise<unknown> {
    const headers: Record<string, string> = {
      apikey: this.config.key,
      "Content-Type": "application/json",
    };
    if (this.config.key.split(".").length === 3 && !this.config.key.startsWith("sb_")) {
      headers.Authorization = "Bearer " + this.config.key;
    }
    try {
      const response = await this.fetcher(this.config.url.replace(/\/+$/, "") + path, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
        redirect: typeof (globalThis as any).WebSocketPair !== "undefined" ? "manual" : "error",
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new TransportError(`Supabase HTTP ${response.status}: ${text.slice(0, 300)}`);
      }
      return await readBoundedJson(response);
    } catch (err: unknown) {
      if (err instanceof TransportError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      throw new TransportError(`Supabase transport error: ${msg}`);
    }
  }

  async rpc(name: string, payload: Record<string, unknown>): Promise<unknown> {
    return await this.post("/rest/v1/rpc/" + name, payload);
  }

  async signedUrl(objectPath: string): Promise<string> {
    const encodedPath = objectPath
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    const res = (await this.post(
      "/storage/v1/object/sign/social-media/" + encodedPath,
      { expiresIn: 3600 }
    )) as Record<string, unknown> | null;
    const value = res?.signedURL ?? res?.signedUrl;
    if (typeof value !== "string" || !value || value.includes("\\") || value.startsWith("//")) {
      throw new TransportError("Invalid signed URL");
    }
    const base = this.config.url.replace(/\/+$/, "");
    const normalizedPath = value.startsWith("/object/") ? "/storage/v1" + value : value;
    let url: URL;
    let expected: URL;
    try {
      url = new URL(normalizedPath, base + "/storage/v1/");
      expected = new URL(base);
    } catch {
      throw new TransportError("Invalid signed URL");
    }
    if (
      url.protocol !== "https:" ||
      url.host !== expected.host ||
      url.username ||
      url.password ||
      url.hash ||
      !url.pathname.startsWith("/storage/v1/object/sign/social-media/")
    ) {
      throw new TransportError("Invalid signed URL origin or path");
    }
    return url.toString();
  }
}

function formatPriceBaht(price: unknown): string {
  if (typeof price === "boolean" || (typeof price !== "number" && typeof price !== "string")) {
    throw new ValueError("Invalid price");
  }
  if (typeof price === "number" && !Number.isFinite(price)) {
    throw new ValueError("Invalid price");
  }
  const text = String(price).trim();
  const match = /^([+-])?(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match || match[1] === "-") {
    throw new ValueError("Invalid price");
  }
  const intPart = match[2].replace(/^0+(?=\d)/, "");
  const maxInt = BigInt("999999999999999");
  const rawBig = BigInt(intPart);
  if (rawBig > maxInt) {
    throw new ValueError("Invalid price");
  }
  const fracRaw = (match[3] ?? "").padEnd(3, "0");
  const cents = BigInt(fracRaw.slice(0, 2));
  const thirdDigit = Number(fracRaw[2] ?? "0");
  const remainderAfterThird = fracRaw.slice(3);
  let scaled = rawBig * 100n + cents;
  if (
    thirdDigit > 5 ||
    (thirdDigit === 5 &&
      (/[1-9]/.test(remainderAfterThird) || cents % 2n === 1n))
  ) {
    scaled += 1n;
  }
  if (scaled > maxInt * 100n) {
    throw new ValueError("Invalid price");
  }
  const finalInt = scaled / 100n;
  const finalCents = (scaled % 100n).toString().padStart(2, "0");
  return `ราคา ${finalInt.toString()}.${finalCents} บาท`;
}

export function validateContent(
  snapshot: unknown
): { caption: string; path: string | null } {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) {
    throw new ValueError("Invalid snapshot");
  }
  const snap = snapshot as Record<string, unknown>;
  if (snap.schema_version !== 1) {
    throw new ValueError("Unsupported snapshot schema");
  }
  const destination = snap.destination;
  if (!destination || typeof destination !== "object" || Array.isArray(destination)) {
    throw new ValueError("Invalid Facebook destination");
  }
  const dest = destination as Record<string, unknown>;
  if (
    dest.platform !== "facebook" ||
    !/^\d+$/.test(String(dest.page_id ?? ""))
  ) {
    throw new ValueError("Invalid Facebook destination");
  }

  const parts: string[] = [];
  for (const key of ["title", "description"] as const) {
    const value = snap[key];
    if (value !== undefined && value !== null && typeof value !== "string") {
      throw new ValueError("Invalid caption text");
    }
    if (typeof value === "string" && value.trim()) {
      parts.push(value.trim());
    }
  }

  if (snap.price !== undefined && snap.price !== null) {
    parts.push(formatPriceBaht(snap.price));
  }

  const websiteUrl = "https://www.elephant-maker.com/";
  if (!parts.some((p) => p.includes("elephant-maker.com"))) {
    parts.push(`🌐 ดูเพิ่มเติมได้ที่: ${websiteUrl}`);
  }

  let tags = snap.hashtags ?? [];
  if (typeof tags === "string") {
    tags = tags.trim() ? tags.trim().split(/\s+/) : [];
  }
  if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string")) {
    throw new ValueError("Invalid hashtags");
  }
  const normalized = (tags as string[])
    .map((tag) => tag.trim().replace(/^#+/, ""))
    .filter((tag) => tag.length > 0)
    .map((tag) => "#" + tag);
  if (normalized.length > 0) {
    parts.push(normalized.join(" "));
  }

  const caption = parts.join("\n\n");
  if (!caption || caption.length > 63206) {
    throw new ValueError("Caption is empty or too long");
  }

  const assets = snap.assets ?? [];
  if (!Array.isArray(assets)) {
    throw new ValueError("Invalid assets");
  }

  const unique = new Map<string, { mime_type: string; size_bytes: number }>();
  for (const rawAsset of assets) {
    if (!rawAsset || typeof rawAsset !== "object" || Array.isArray(rawAsset)) {
      throw new ValueError("Invalid asset");
    }
    const asset = rawAsset as Record<string, unknown>;
    const mime = asset.mime_type;
    if (mime !== "image/jpeg" && mime !== "image/png" && mime !== "video/mp4") {
      throw new ValueError("Unsupported media: only JPEG/PNG or MP4");
    }
    const size = asset.size_bytes;
    const maximum = mime === "video/mp4" ? 2 * 1024 ** 3 : 10 * 1024 * 1024;
    if (
      typeof size !== "number" ||
      !Number.isInteger(size) ||
      size <= 0 ||
      size > maximum
    ) {
      throw new ValueError(
        mime === "video/mp4"
          ? "Video must be at most 2 GiB"
          : "Image must be at most 10 MiB"
      );
    }
    const path = asset.object_path;
    if (
      typeof path !== "string" ||
      path.includes("\\") ||
      path.includes("%")
    ) {
      throw new ValueError("Invalid private object path");
    }
    const segments = path.split("/");
    if (
      segments.length < 2 ||
      segments.some((p) => p === "" || p === "." || p === "..")
    ) {
      throw new ValueError("Invalid private object path");
    }
    if (!UUID_REGEX.test(segments[0])) {
      throw new ValueError("Object path must start with owner UUID");
    }
    for (let i = 0; i < path.length; i++) {
      if (path.charCodeAt(i) < 32) {
        throw new ValueError("Invalid private object path");
      }
    }
    const existing = unique.get(path);
    if (
      existing &&
      (existing.mime_type !== mime || existing.size_bytes !== size)
    ) {
      throw new ValueError("Conflicting duplicate asset");
    }
    unique.set(path, { mime_type: mime, size_bytes: size });
  }

  const videos: string[] = [];
  for (const [path, asset] of unique.entries()) {
    if (asset.mime_type === "video/mp4") {
      videos.push(path);
    }
  }
  if (videos.length > 1) {
    throw new ValueError("Unsupported media: more than one unique video");
  }
  if (videos.length === 1) {
    return { caption, path: videos[0] };
  }
  if (unique.size > 1) {
    throw new ValueError("Unsupported media: more than one unique media object");
  }
  const firstPath = unique.keys().next().value ?? null;
  return { caption, path: firstPath };
}

export class Facebook {
  readonly config: Config;
  readonly fetcher: FetchLike;

  constructor(config: Config, fetcher: FetchLike = fetch) {
    this.config = config;
    this.fetcher = (input, init) => fetcher(input, init);
  }

  async publish(
    caption: string,
    imageUrl: string | null = null,
    options?: { videoUrl?: string | null }
  ): Promise<PublishResult> {
    const videoUrl = options?.videoUrl ?? null;
    let endpoint: string;
    let payload: Record<string, unknown>;
    if (videoUrl) {
      endpoint = "videos";
      payload = { file_url: videoUrl, description: caption, published: true };
    } else if (imageUrl) {
      endpoint = "photos";
      payload = { url: imageUrl, caption };
    } else {
      endpoint = "feed";
      payload = { message: caption };
    }

    const requestUrl = `https://graph.facebook.com/${this.config.facebookVersion}/${this.config.facebookPageId}/${endpoint}`;
    try {
      const response = await this.fetcher(requestUrl, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + this.config.facebookToken,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
        redirect: typeof (globalThis as any).WebSocketPair !== "undefined" ? "manual" : "error",
        signal: AbortSignal.timeout(20_000),
      });

      if (!response.ok) {
        if (response.status >= 400 && response.status < 500) {
          try {
            const body = (await readBoundedJson(response)) as Record<string, unknown> | null;
            const graph = body?.error as Record<string, unknown> | undefined;
            const code = graph?.code;
            if (
              typeof code === "number" &&
               Number.isInteger(code) &&
              DEFINITIVE_GRAPH_CODES.has(code) &&
              !graph?.is_transient
            ) {
              return result("failed", `Facebook rejected request (code ${code})`);
            }
          } catch {
            // Fall through to uncertain delivery
          }
        }
        return result("blocked", "Facebook delivery uncertain", {
          delivery_uncertain: true,
        });
      }

      const data = (await readBoundedJson(response)) as Record<string, unknown> | null;
      const postId =
        imageUrl && !videoUrl ? data?.post_id : data?.id;
      if (typeof postId !== "string" || !/^\d+(?:_\d+)?$/.test(postId)) {
        throw new ValueError("Missing post ID");
      }
      return result("published", null, {
        external_post_id: postId,
        published_url: "https://www.facebook.com/" + postId,
      });
    } catch {
      return result("blocked", "Facebook delivery uncertain", {
        delivery_uncertain: true,
      });
    }
  }
}

export function processLegacyTarget(
  _target: Record<string, unknown>,
  mode: "simulation" | "live"
): PublishResult {
  if (mode === "simulation") {
    return result("simulated", null);
  }
  return result("blocked", "Legacy snapshot not configured; live publishing blocked");
}

export interface TransportLike {
  rpc(name: string, payload: Record<string, unknown>): Promise<unknown>;
  signedUrl(objectPath: string): Promise<string>;
}

export interface FacebookLike {
  publish(
    caption: string,
    imageUrl?: string | null,
    options?: { videoUrl?: string | null }
  ): Promise<PublishResult>;
}

export type ExtraPlatform = "youtube" | "tiktok" | "x";

export interface PublishInput {
  caption: string;
  title: string;
  hashtags: string[];
  mediaUrl: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
}

export interface PlatformPublisher {
  publish(input: PublishInput): Promise<PublishResult>;
}

export type PlatformPublishers = Partial<Record<ExtraPlatform, PlatformPublisher>>;

/** Wraps a streamed body so Workers send a fixed Content-Length instead of chunked encoding. */
function fixedLength(body: ReadableStream<Uint8Array>, size: number): ReadableStream<Uint8Array> {
  const FLS = (globalThis as unknown as { FixedLengthStream?: new (n: number) => TransformStream<Uint8Array, Uint8Array> }).FixedLengthStream;
  if (!FLS) return body;
  const stream = new FLS(size);
  void body.pipeTo(stream.writable).catch(() => {});
  return stream.readable;
}

export function youtubePublisher(env: WorkerEnv, fetcher: FetchLike = fetch): PlatformPublisher | undefined {
  if (env.YOUTUBE_LIVE_ENABLED !== "true" || !env.YOUTUBE_CLIENT_ID || !env.YOUTUBE_CLIENT_SECRET || !env.YOUTUBE_REFRESH_TOKEN) return undefined;
  const adapter = new YouTubeAdapter(
    { clientId: env.YOUTUBE_CLIENT_ID, clientSecret: env.YOUTUBE_CLIENT_SECRET, refreshToken: env.YOUTUBE_REFRESH_TOKEN, liveEnabled: true },
    fetcher as typeof fetch
  );
  const privacy = env.YOUTUBE_PRIVACY_STATUS === "private" || env.YOUTUBE_PRIVACY_STATUS === "unlisted" ? env.YOUTUBE_PRIVACY_STATUS : "public";
  return {
    async publish(input) {
      if (input.mimeType !== "video/mp4" || !input.mediaUrl || !input.sizeBytes) {
        return result("blocked", "YouTube requires one MP4 video");
      }
      let uploadStarted = false;
      try {
        const token = await adapter.getAccessToken();
        const uploadUrl = await adapter.createUploadSession(
          token,
          { title: input.title || "Untitled", description: input.caption, tags: input.hashtags, privacyStatus: privacy },
          input.sizeBytes
        );
        const source = await fetcher(input.mediaUrl, { signal: AbortSignal.timeout(60_000) });
        if (!source.ok || !source.body) return result("blocked", "Failed to read video from storage");
        uploadStarted = true;
        const videoId = await adapter.uploadVideoBytes(uploadUrl, fixedLength(source.body, input.sizeBytes), input.sizeBytes);
        return result("published", null, { external_post_id: videoId, published_url: `https://www.youtube.com/watch?v=${videoId}` });
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 300) : "YouTube publish error";
        return result(uploadStarted ? "blocked" : "failed", message, { delivery_uncertain: uploadStarted });
      }
    },
  };
}

export function xPublisher(env: WorkerEnv, fetcher: FetchLike = fetch): PlatformPublisher | undefined {
  if (env.X_LIVE_ENABLED !== "true" || !env.X_API_KEY || !env.X_API_SECRET || !env.X_ACCESS_TOKEN || !env.X_ACCESS_SECRET) return undefined;
  const adapter = new XAdapter(
    { apiKey: env.X_API_KEY, apiSecret: env.X_API_SECRET, accessToken: env.X_ACCESS_TOKEN, accessSecret: env.X_ACCESS_SECRET, liveEnabled: true },
    fetcher as typeof fetch
  );
  return {
    async publish(input) {
      const chars = Array.from(input.caption);
      const text = chars.length <= 270 ? input.caption : chars.slice(0, 267).join("") + "...";
      const r = await adapter.postTweet({ text }, "live");
      return result(r.status, r.error, { external_post_id: r.tweetId, published_url: r.publishedUrl, delivery_uncertain: r.deliveryUncertain });
    },
  };
}

export function tiktokPublisher(env: WorkerEnv, fetcher: FetchLike = fetch): PlatformPublisher | undefined {
  if (env.TIKTOK_LIVE_ENABLED !== "true" || !env.TIKTOK_CLIENT_KEY || !env.TIKTOK_CLIENT_SECRET) return undefined;
  const adapter = new TikTokAdapter(
    { clientKey: env.TIKTOK_CLIENT_KEY, clientSecret: env.TIKTOK_CLIENT_SECRET, redirectUri: "", accessToken: env.TIKTOK_ACCESS_TOKEN, liveEnabled: true },
    fetcher as typeof fetch
  );
  const privacy = env.TIKTOK_PRIVACY_LEVEL === "SELF_ONLY" ? "SELF_ONLY" : "PUBLIC_TO_EVERYONE";
  return {
    async publish(input) {
      let token = env.TIKTOK_ACCESS_TOKEN;
      if (!token && env.TIKTOK_REFRESH_TOKEN) {
        try {
          const refreshed = await adapter.refreshAccessToken(env.TIKTOK_REFRESH_TOKEN);
          token = refreshed.accessToken;
        } catch (e) {
          const msg = e instanceof Error ? e.message.slice(0, 300) : "TikTok token refresh failed";
          return result("blocked", msg);
        }
      }
      if (!token) return result("blocked", "TikTok Direct Post requires user OAuth authorization token");
      if (input.mimeType !== "video/mp4" || !input.mediaUrl || !input.sizeBytes) return result("blocked", "TikTok requires one MP4 video");
      let uploadStarted = false;
      try {
        let session: { publishId: string; uploadUrl: string };
        try {
          session = await adapter.initVideoPost(token, { title: input.caption, privacyLevel: privacy }, input.sizeBytes);
        } catch (initErr) {
          // If token expired and refresh token is available, attempt one refresh
          if (env.TIKTOK_REFRESH_TOKEN) {
            const refreshed = await adapter.refreshAccessToken(env.TIKTOK_REFRESH_TOKEN);
            token = refreshed.accessToken;
            session = await adapter.initVideoPost(token, { title: input.caption, privacyLevel: privacy }, input.sizeBytes);
          } else {
            throw initErr;
          }
        }
        const source = await fetcher(input.mediaUrl, { signal: AbortSignal.timeout(60_000) });
        if (!source.ok || !source.body) return result("blocked", "Failed to read video from storage");
        uploadStarted = true;
        await adapter.uploadVideoBytes(session.uploadUrl, fixedLength(source.body, input.sizeBytes), input.sizeBytes);
        let postUrl = "https://www.tiktok.com/@decraych";
        try {
          const statusResult = await adapter.getPublishStatus(token, session.publishId);
          if (statusResult.postId) {
            postUrl = `https://www.tiktok.com/@decraych/video/${statusResult.postId}`;
          }
        } catch {}
        return result("published", null, { external_post_id: session.publishId, published_url: postUrl });
      } catch (error) {
        const message = error instanceof Error ? error.message.slice(0, 300) : "TikTok publish error";
        return result(uploadStarted ? "blocked" : "failed", message, { delivery_uncertain: uploadStarted });
      }
    },
  };
}

export function publishersFromEnv(env: WorkerEnv, fetcher: FetchLike = fetch): PlatformPublishers {
  return { youtube: youtubePublisher(env, fetcher), x: xPublisher(env, fetcher), tiktok: tiktokPublisher(env, fetcher) };
}

export class Worker {
  readonly config: Config;
  readonly transport: TransportLike;
  readonly facebook: FacebookLike;
  readonly legacyProcessor: typeof processLegacyTarget;
  readonly publishers: PlatformPublishers;

  constructor(
    config: Config,
    transport?: TransportLike,
    facebook?: FacebookLike,
    legacyProcessor: typeof processLegacyTarget = processLegacyTarget,
    publishers: PlatformPublishers = {}
  ) {
    this.config = config;
    this.transport = transport ?? new Supabase(config);
    this.facebook = facebook ?? new Facebook(config);
    this.legacyProcessor = legacyProcessor;
    this.publishers = publishers;
  }

  async process(target: Record<string, unknown>): Promise<PublishResult> {
    const snapshot = target.content_snapshot;
    if (snapshot === undefined || snapshot === null) {
      if (target.execution_mode === "live") {
        return result("blocked", "Legacy live target has no snapshot");
      }
      return this.legacyProcessor(target, this.config.mode);
    }
    const platform = target.platform;
    if (platform !== "facebook" && platform !== "youtube" && platform !== "tiktok" && platform !== "x") {
      return result("blocked", "Snapshot platform is not supported");
    }
    let caption: string;
    let path: string | null;
    try {
      const validated = validateContent(snapshot);
      caption = validated.caption;
      path = validated.path;
    } catch (error) {
      return result(
        "blocked",
        error instanceof ValueError ? error.message : "Invalid snapshot"
      );
    }

    const snapObj = snapshot as Record<string, unknown>;
    const mode = snapObj.execution_mode;
    if (
      (mode !== "simulation" && mode !== "live") ||
      target.execution_mode !== mode
    ) {
      return result("blocked", "Invalid or conflicting execution mode");
    }
    if (mode === "simulation") {
      return result("simulated");
    }

    const c = this.config;
    if (platform !== "facebook") {
      return await this.processExtra(target, platform, snapObj, caption, path);
    }
    if (
      c.mode !== "live" ||
      c.facebookLiveEnabled !== true ||
      !c.facebookToken ||
      c.leaseSeconds < 120
    ) {
      return result(
        "blocked",
        "Live gates closed: mode, enable flag, token or minimum lease"
      );
    }
    const dest = snapObj.destination as Record<string, unknown>;
    if (String(dest.page_id) !== c.facebookPageId) {
      return result("blocked", "Facebook page ID mismatch");
    }

    let url: string | null = null;
    let accepted: unknown;
    try {
      url = path ? await this.transport.signedUrl(path) : null;
      accepted = await this.transport.rpc("begin_target_dispatch", {
        p_target_id: target.id,
        p_lease_token: target.lease_token,
      });
    } catch {
      return result("blocked", "Dispatch preparation failed");
    }
    if (accepted !== true) {
      return result("blocked", "Dispatch authorization rejected");
    }

    try {
      const assets = (snapObj.assets as Array<Record<string, unknown>>) ?? [];
      const selected = assets.find((asset) => asset.object_path === path);
      if (selected && selected.mime_type === "video/mp4") {
        return await this.facebook.publish(caption, null, { videoUrl: url });
      }
      return await this.facebook.publish(caption, url);
    } catch {
      return result("blocked", "Facebook delivery uncertain", {
        delivery_uncertain: true,
      });
    }
  }

  async processExtra(
    target: Record<string, unknown>,
    platform: ExtraPlatform,
    snap: Record<string, unknown>,
    caption: string,
    path: string | null
  ): Promise<PublishResult> {
    const publisher = this.publishers[platform];
    if (this.config.mode !== "live" || this.config.leaseSeconds < 120 || !publisher) {
      return result("blocked", `${platform} live gate closed or credentials missing`);
    }
    const assets = (snap.assets as Array<Record<string, unknown>>) ?? [];
    const selected = path ? assets.find((asset) => asset.object_path === path) : undefined;
    const hashtags = Array.isArray(snap.hashtags)
      ? (snap.hashtags as unknown[]).filter((t): t is string => typeof t === "string").map((t) => t.replace(/^#+/, "").trim()).filter(Boolean)
      : [];
    let mediaUrl: string | null = null;
    let accepted: unknown;
    try {
      mediaUrl = path ? await this.transport.signedUrl(path) : null;
      accepted = await this.transport.rpc("begin_target_dispatch", {
        p_target_id: target.id,
        p_lease_token: target.lease_token,
      });
    } catch {
      return result("blocked", "Dispatch preparation failed");
    }
    if (accepted !== true) {
      return result("blocked", "Dispatch authorization rejected");
    }
    try {
      return await publisher.publish({
        caption,
        title: typeof snap.title === "string" ? snap.title.trim() : "",
        hashtags,
        mediaUrl,
        mimeType: typeof selected?.mime_type === "string" ? selected.mime_type : null,
        sizeBytes: typeof selected?.size_bytes === "number" ? selected.size_bytes : null,
      });
    } catch {
      return result("blocked", `${platform} delivery uncertain`, { delivery_uncertain: true });
    }
  }

  async runOnce(): Promise<boolean> {
    let target: unknown;
    try {
      target = await this.transport.rpc("claim_target", {
        p_lease_seconds: this.config.leaseSeconds,
      });
    } catch {
      console.warn("Claim request failed; will retry after polling interval");
      return false;
    }
    if (target === null || target === undefined) {
      return false;
    }
    if (
      typeof target !== "object" ||
      Array.isArray(target) ||
      !(target as Record<string, unknown>).id ||
      !(target as Record<string, unknown>).lease_token
    ) {
      console.error("Invalid claim response; lease will expire");
      return false;
    }

    const claimed = target as Record<string, unknown>;
    let outcome: PublishResult;
    try {
      outcome = await this.process(claimed);
    } catch {
      outcome = result("failed", "Worker processing failed");
    }

    try {
      const accepted = await this.transport.rpc("finish_target", {
        p_target_id: claimed.id,
        p_lease_token: claimed.lease_token,
        p_status: outcome.status,
        p_error: outcome.error,
        p_published_url: outcome.published_url,
        p_external_post_id: outcome.external_post_id,
        p_delivery_uncertain: outcome.delivery_uncertain,
      });
      if (accepted !== true) {
        console.warn("Finish rejected; lease expired or superseded");
      } else {
        console.info(`Target finished: ${outcome.status}`);
      }
    } catch {
      console.warn("Finish request failed; lease recovery will handle target");
    }
    return true;
  }
}

const cloudflareWorker = {
  async fetch(
    request?: Request,
    env?: WorkerEnv,
    _ctx?: { waitUntil?: (promise: Promise<unknown>) => void }
  ): Promise<Response> {
    if (!request?.url) {
      return new Response("Not Found", {
        status: 404,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    }
    const url = new URL(request.url);
    if ((url.pathname === "/run" || url.pathname === "/trigger") && env) {
      let config: Config;
      try {
        config = Config.fromEnv(env);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : "Config error";
        return new Response(JSON.stringify({ error: msg }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        });
      }
      const worker = new Worker(config, undefined, undefined, processLegacyTarget, publishersFromEnv(env));
      let processed = 0;
      const limit = Math.min(Math.max(Number.parseInt(env.MAX_TARGETS_PER_RUN ?? "8", 10) || 8, 1), 20);
      const logs: string[] = [];
      let lastErr: string | null = null;
      for (let i = 0; i < limit; i++) {
        let target: unknown;
        try {
          target = await worker.transport.rpc("claim_target", {
            p_lease_seconds: worker.config.leaseSeconds,
          });
        } catch (e: unknown) {
          lastErr = e instanceof Error ? e.message : String(e);
          break;
        }
        if (!target) {
          logs.push(`iteration ${i}: claim_target returned null`);
          break;
        }
        const claimed = target as Record<string, unknown>;
        logs.push(`iteration ${i}: claimed ${claimed.id} (${claimed.platform})`);
        let outcome: PublishResult;
        try {
          outcome = await worker.process(claimed);
        } catch (e: unknown) {
          outcome = result("failed", e instanceof Error ? e.message : "Processing failed");
        }
        logs.push(`iteration ${i}: outcome ${outcome.status} (${outcome.error || "no error"})`);
        try {
          await worker.transport.rpc("finish_target", {
            p_target_id: claimed.id,
            p_lease_token: claimed.lease_token,
            p_status: outcome.status,
            p_error: outcome.error,
            p_published_url: outcome.published_url,
            p_external_post_id: outcome.external_post_id,
            p_delivery_uncertain: outcome.delivery_uncertain,
          });
        } catch (e: unknown) {
          logs.push(`finish error: ${e instanceof Error ? e.message : String(e)}`);
        }
        processed++;
      }
      return new Response(JSON.stringify({ ok: true, processed, logs, lastErr, config: worker.config.toJSON() }), {
        headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }
    return new Response("AutoPost Worker Ready", {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" },
    });
  },

  async scheduled(
    _controller: unknown,
    env: WorkerEnv,
    _ctx?: { waitUntil?: (promise: Promise<unknown>) => void }
  ): Promise<void> {
    let config: Config;
    try {
      config = Config.fromEnv(env);
    } catch {
      console.error(
        "Invalid worker configuration; check required environment variables"
      );
      return;
    }
    const worker = new Worker(config, undefined, undefined, processLegacyTarget, publishersFromEnv(env));
    // Drain several targets per cron tick so a 4-platform job does not take 4 minutes.
    const limit = Math.min(Math.max(Number.parseInt(env.MAX_TARGETS_PER_RUN ?? "8", 10) || 8, 1), 20);
    for (let i = 0; i < limit; i++) {
      if (!(await worker.runOnce())) break;
    }
  },
};

export default cloudflareWorker;

