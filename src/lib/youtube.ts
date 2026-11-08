/**
 * YouTube Publishing Adapter for Auto-post.
 * Handles OAuth2 token refresh and Resumable Video Uploads to YouTube Data API v3.
 */

export interface YouTubeConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  channelId?: string;
  liveEnabled?: boolean;
}

export interface YouTubeVideoMetadata {
  title: string;
  description: string;
  tags?: string[];
  privacyStatus?: "public" | "private" | "unlisted";
}

export interface YouTubePublishResult {
  status: "published" | "simulated" | "failed" | "blocked";
  error: string | null;
  videoId: string | null;
  publishedUrl: string | null;
  deliveryUncertain: boolean;
}

export class YouTubeAdapter {
  readonly config: YouTubeConfig;
  readonly fetcher: typeof fetch;

  constructor(config: YouTubeConfig, fetcher: typeof fetch = fetch) {
    this.config = config;
    this.fetcher = (input: any, init?: any) => fetcher(input, init);
  }

  async getAccessToken(): Promise<string> {
    const res = await this.fetcher("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        refresh_token: this.config.refreshToken,
        grant_type: "refresh_token",
      }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      throw new Error(`Failed to refresh YouTube access token: HTTP ${res.status}`);
    }

    const data = (await res.json()) as { access_token?: string; error?: string };
    if (!data.access_token) {
      throw new Error(`Missing access_token in refresh response: ${data.error || "Unknown error"}`);
    }

    return data.access_token;
  }

  /**
   * Initiates a YouTube Resumable Upload session.
   * Returns the upload URL where video bytes should be streamed.
   */
  async createUploadSession(
    accessToken: string,
    metadata: YouTubeVideoMetadata,
    totalSizeBytes: number
  ): Promise<string> {
    const body = {
      snippet: {
        title: metadata.title.slice(0, 100), // YouTube title max 100 chars
        description: metadata.description.slice(0, 5000),
        tags: metadata.tags || [],
        categoryId: "22", // People & Blogs default
      },
      status: {
        privacyStatus: metadata.privacyStatus || "public",
        selfDeclaredMadeForKids: false,
      },
    };

    const res = await this.fetcher(
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Length": totalSizeBytes.toString(),
          "X-Upload-Content-Type": "video/mp4",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      }
    );

    if (!res.ok) {
      throw new Error(`Failed to create YouTube upload session: HTTP ${res.status}`);
    }

    const uploadUrl = res.headers.get("Location") || res.headers.get("location");
    if (!uploadUrl) {
      throw new Error("Missing Location header for YouTube resumable upload");
    }

    return uploadUrl;
  }

  /**
   * Uploads video stream/bytes to the resumable upload URL.
   */
  async uploadVideoBytes(
    uploadUrl: string,
    videoData: ArrayBuffer | Uint8Array | ReadableStream,
    totalSizeBytes: number
  ): Promise<string> {
    const res = await this.fetcher(uploadUrl, {
      method: "PUT",
      headers: {
        "Content-Length": totalSizeBytes.toString(),
        "Content-Type": "video/mp4",
      },
      // @ts-ignore - duplex for Node/fetch streams if applicable
      duplex: "half",
      body: videoData as BodyInit,
      signal: AbortSignal.timeout(300_000), // 5 min timeout for video upload
    });

    if (!res.ok && res.status !== 200 && res.status !== 201) {
      throw new Error(`YouTube video upload failed: HTTP ${res.status}`);
    }

    const data = (await res.json()) as { id?: string };
    if (!data.id) {
      throw new Error("YouTube video upload response missing video id");
    }

    return data.id;
  }

  /**
   * Full end-to-end publish flow from a remote video URL (e.g. Supabase Storage signed URL).
   */
  async publishFromUrl(
    videoUrl: string,
    metadata: YouTubeVideoMetadata,
    mode: "live" | "simulation" = "simulation"
  ): Promise<YouTubePublishResult> {
    if (mode === "simulation") {
      return {
        status: "simulated",
        error: null,
        videoId: null,
        publishedUrl: null,
        deliveryUncertain: false,
      };
    }

    if (!this.config.liveEnabled) {
      return {
        status: "blocked",
        error: "YouTube live publishing is disabled by safety gate",
        videoId: null,
        publishedUrl: null,
        deliveryUncertain: false,
      };
    }

    try {
      // 1. Fetch video metadata / head from storage URL to get size
      const headRes = await this.fetcher(videoUrl, { method: "HEAD", signal: AbortSignal.timeout(15_000) });
      const contentLength = headRes.headers.get("content-length");
      const sizeBytes = contentLength ? parseInt(contentLength, 10) : 0;

      if (!sizeBytes || isNaN(sizeBytes)) {
        return {
          status: "blocked",
          error: "Unable to determine video size from storage URL",
          videoId: null,
          publishedUrl: null,
          deliveryUncertain: false,
        };
      }

      // 2. Refresh token
      const accessToken = await this.getAccessToken();

      // 3. Create upload session
      const uploadUrl = await this.createUploadSession(accessToken, metadata, sizeBytes);

      // 4. Stream video from storage to YouTube
      const videoStreamRes = await this.fetcher(videoUrl, { signal: AbortSignal.timeout(60_000) });
      if (!videoStreamRes.ok || !videoStreamRes.body) {
        return {
          status: "blocked",
          error: `Failed to download video from storage: HTTP ${videoStreamRes.status}`,
          videoId: null,
          publishedUrl: null,
          deliveryUncertain: false,
        };
      }

      const videoId = await this.uploadVideoBytes(uploadUrl, videoStreamRes.body, sizeBytes);
      const publishedUrl = `https://www.youtube.com/watch?v=${videoId}`;

      return {
        status: "published",
        error: null,
        videoId,
        publishedUrl,
        deliveryUncertain: false,
      };
    } catch (err: any) {
      return {
        status: "blocked",
        error: `YouTube publish error: ${err.message}`,
        videoId: null,
        publishedUrl: null,
        deliveryUncertain: true,
      };
    }
  }
}

