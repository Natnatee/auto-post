/**
 * TikTok Content Posting API Adapter for Auto-post.
 * Supports OAuth 2.0 authorization code flow, token refresh,
 * Direct Post initialization, and chunked video upload.
 */

export interface TikTokConfig {
  clientKey: string;
  clientSecret: string;
  redirectUri: string;
  accessToken?: string;
  refreshToken?: string;
  liveEnabled?: boolean;
  sandbox?: boolean;
}

export interface TikTokVideoMetadata {
  title: string;
  privacyLevel?: "PUBLIC_TO_EVERYONE" | "MUTUAL_FOLLOW_FRIENDS" | "SELF_ONLY";
  disableDuet?: boolean;
  disableStitch?: boolean;
  disableComment?: boolean;
  videoCoverTimestampMs?: number;
}

export interface TikTokPublishResult {
  status: "published" | "simulated" | "failed" | "blocked";
  error: string | null;
  publishId: string | null;
  publishedUrl: string | null;
  deliveryUncertain: boolean;
}

export class TikTokAdapter {
  readonly config: TikTokConfig;
  readonly baseUrl: string;
  readonly fetcher: typeof fetch;

  constructor(config: TikTokConfig, fetcher: typeof fetch = fetch) {
    this.config = config;
    this.baseUrl = "https://open.tiktokapis.com";
    this.fetcher = (input: any, init?: any) => fetcher(input, init);
  }

  /**
   * Refreshes an expired user access token using the refresh_token.
   */
  async refreshAccessToken(refreshToken: string): Promise<{ accessToken: string; newRefreshToken: string }> {
    const res = await this.fetcher(`${this.baseUrl}/v2/oauth/token/`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_key: this.config.clientKey,
        client_secret: this.config.clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const data = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      error?: string;
      message?: string;
    };

    if (!res.ok || !data.access_token) {
      throw new Error(`TikTok token refresh failed: ${data.message || data.error || res.status}`);
    }

    return {
      accessToken: data.access_token,
      newRefreshToken: data.refresh_token || refreshToken,
    };
  }

  /**
   * Initializes a Direct Post video upload session with TikTok Content Posting API.
   * Returns publish_id and upload_url.
   */
  async initVideoPost(
    accessToken: string,
    metadata: TikTokVideoMetadata,
    totalSizeBytes: number
  ): Promise<{ publishId: string; uploadUrl: string }> {
    const payload = {
      post_info: {
        title: metadata.title.slice(0, 2200), // TikTok caption max 2200 chars
        privacy_level: metadata.privacyLevel || "PUBLIC_TO_EVERYONE",
        disable_duet: metadata.disableDuet ?? false,
        disable_stitch: metadata.disableStitch ?? false,
        disable_comment: metadata.disableComment ?? false,
        video_cover_timestamp_ms: metadata.videoCoverTimestampMs ?? 1000,
      },
      source_info: {
        source: "FILE_UPLOAD",
        video_size: totalSizeBytes,
        chunk_size: totalSizeBytes, // Single chunk upload if under chunk limits
        total_chunk_count: 1,
      },
    };

    const res = await this.fetcher(`${this.baseUrl}/v2/post/publish/video/init/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });

    const json = (await res.json()) as {
      data?: { publish_id: string; upload_url: string };
      error?: { code: string; message: string };
    };

    if (!res.ok || !json.data?.upload_url) {
      if (json.error?.code === "unaudited_client_can_only_post_to_private_accounts") {
        return this.initInboxVideoPost(accessToken, totalSizeBytes);
      }
      throw new Error(`Failed to initialize TikTok post: ${json.error?.message || res.status}`);
    }

    return {
      publishId: json.data.publish_id,
      uploadUrl: json.data.upload_url,
    };
  }

  /**
   * Initializes an Inbox/Draft video upload session with TikTok Content Posting API.
   * Useful when client is unaudited and target account is public.
   */
  async initInboxVideoPost(
    accessToken: string,
    totalSizeBytes: number
  ): Promise<{ publishId: string; uploadUrl: string }> {
    const payload = {
      source_info: {
        source: "FILE_UPLOAD",
        video_size: totalSizeBytes,
        chunk_size: totalSizeBytes,
        total_chunk_count: 1,
      },
    };

    const res = await this.fetcher(`${this.baseUrl}/v2/post/publish/inbox/video/init/`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(20_000),
    });

    const json = (await res.json()) as {
      data?: { publish_id: string; upload_url: string };
      error?: { code: string; message: string };
    };

    if (!res.ok || !json.data?.upload_url) {
      throw new Error(`Failed to initialize TikTok inbox post: ${json.error?.message || res.status}`);
    }

    return {
      publishId: json.data.publish_id,
      uploadUrl: json.data.upload_url,
    };
  }

  /**
   * Streams video bytes to TikTok's upload_url.
   */
  async uploadVideoBytes(
    uploadUrl: string,
    videoData: ArrayBuffer | Uint8Array | ReadableStream,
    totalSizeBytes: number
  ): Promise<void> {
    const res = await this.fetcher(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Range": `bytes 0-${totalSizeBytes - 1}/${totalSizeBytes}`,
        "Content-Type": "video/mp4",
        "Content-Length": totalSizeBytes.toString(),
      },
      // @ts-ignore
      duplex: "half",
      body: videoData as BodyInit,
      signal: AbortSignal.timeout(300_000),
    });

    if (!res.ok && res.status !== 200 && res.status !== 201) {
      throw new Error(`TikTok video binary upload failed: HTTP ${res.status}`);
    }
  }

  /**
   * Fetches creator profile information (e.g. username).
   */
  async getCreatorUsername(accessToken: string): Promise<string | null> {
    try {
      const res = await this.fetcher(`${this.baseUrl}/v2/post/publish/creator_info/query/`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
        },
        signal: AbortSignal.timeout(10_000),
      });
      const json = (await res.json()) as { data?: { creator_username?: string } };
      return json.data?.creator_username || null;
    } catch {
      return null;
    }
  }

  /**
   * Checks publishing status of an uploaded TikTok video session.
   */
  async getPublishStatus(
    accessToken: string,
    publishId: string
  ): Promise<{ status: string; postId?: string }> {
    try {
      const res = await this.fetcher(`${this.baseUrl}/v2/post/publish/status/fetch/`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
        },
        body: JSON.stringify({ publish_id: publishId }),
        signal: AbortSignal.timeout(15_000),
      });
      const json = (await res.json()) as {
        data?: { status?: string; publicaly_available_post_id?: (string | number)[] };
      };
      const postId = json.data?.publicaly_available_post_id?.[0]?.toString();
      return {
        status: json.data?.status || "PROCESSING",
        postId,
      };
    } catch {
      return { status: "PROCESSING" };
    }
  }

  /**
   * End-to-end publish flow from a signed remote video URL.
   */
  async publishFromUrl(
    videoUrl: string,
    metadata: TikTokVideoMetadata,
    mode: "live" | "simulation" = "simulation"
  ): Promise<TikTokPublishResult> {
    if (mode === "simulation") {
      return {
        status: "simulated",
        error: null,
        publishId: null,
        publishedUrl: null,
        deliveryUncertain: false,
      };
    }

    if (!this.config.liveEnabled) {
      return {
        status: "blocked",
        error: "TikTok live publishing is disabled by safety gate",
        publishId: null,
        publishedUrl: null,
        deliveryUncertain: false,
      };
    }

    if (!this.config.accessToken) {
      return {
        status: "blocked",
        error: "Missing TikTok access token",
        publishId: null,
        publishedUrl: null,
        deliveryUncertain: false,
      };
    }

    try {
      // 1. Get video size
      const headRes = await this.fetcher(videoUrl, { method: "HEAD", signal: AbortSignal.timeout(15_000) });
      const contentLength = headRes.headers.get("content-length");
      const sizeBytes = contentLength ? parseInt(contentLength, 10) : 0;

      if (!sizeBytes || isNaN(sizeBytes)) {
        return {
          status: "blocked",
          error: "Unable to determine video size from storage URL",
          publishId: null,
          publishedUrl: null,
          deliveryUncertain: false,
        };
      }

      // 2. Initialize Direct Post
      const { publishId, uploadUrl } = await this.initVideoPost(
        this.config.accessToken,
        metadata,
        sizeBytes
      );

      // 3. Stream video from storage to TikTok
      const videoRes = await this.fetcher(videoUrl, { signal: AbortSignal.timeout(60_000) });
      if (!videoRes.ok || !videoRes.body) {
        return {
          status: "blocked",
          error: `Failed to download video from storage: HTTP ${videoRes.status}`,
          publishId: null,
          publishedUrl: null,
          deliveryUncertain: false,
        };
      }

      await this.uploadVideoBytes(uploadUrl, videoRes.body, sizeBytes);

      return {
        status: "published",
        error: null,
        publishId,
        publishedUrl: `https://www.tiktok.com/publish/${publishId}`,
        deliveryUncertain: false,
      };
    } catch (err: any) {
      return {
        status: "blocked",
        error: `TikTok publish error: ${err.message}`,
        publishId: null,
        publishedUrl: null,
        deliveryUncertain: true,
      };
    }
  }
}

