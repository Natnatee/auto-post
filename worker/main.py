"""Lease-based publisher; all external publication gates default closed."""
import argparse
import json
import logging
import os
import re
import signal
import threading
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from decimal import Decimal, InvalidOperation
from uuid import UUID

LOG = logging.getLogger("worker")
LIMIT = 1048576


class TransportError(Exception):
    """Safe error without response bodies or credentials."""


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def opener():
    return urllib.request.build_opener(NoRedirect()).open


def read_json(response):
    body = response.read(LIMIT + 1)
    if len(body) > LIMIT:
        raise ValueError("Response too large")
    return json.loads(body)


@dataclass(frozen=True)
class Config:
    url: str
    key: str = field(repr=False)
    mode: str = "simulation"
    poll_seconds: float = 5
    lease_seconds: int = 300
    facebook_token: str = field(default="", repr=False)
    facebook_page_id: str = ""
    facebook_version: str = "v27.0"
    facebook_live_enabled: bool = False

    def __post_init__(self):
        parsed = urllib.parse.urlsplit(self.url)
        if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.path not in ("", "/") or parsed.query or parsed.fragment or not self.key:
            raise ValueError("HTTPS Supabase origin and secret key required")
        if self.mode not in ("simulation", "live"):
            raise ValueError("Invalid worker mode")
        if not 0.1 <= self.poll_seconds <= 3600 or not 10 <= self.lease_seconds <= 3600:
            raise ValueError("Invalid poll or lease interval")
        if not re.fullmatch(r"v\d+\.\d+", self.facebook_version):
            raise ValueError("Invalid Facebook version")

    @classmethod
    def from_env(cls):
        return cls(os.environ.get("SUPABASE_URL", "").rstrip("/"),
                   os.environ.get("SUPABASE_SECRET_KEY") or os.environ.get("SUPABASE_SERVICE_ROLE_KEY", ""),
                   os.environ.get("WORKER_MODE", "simulation"),
                   float(os.environ.get("POLL_SECONDS", "5")),
                   int(os.environ.get("LEASE_SECONDS", "300")),
                   os.environ.get("FACEBOOK_PAGE_ACCESS_TOKEN", ""),
                   os.environ.get("FACEBOOK_PAGE_ID", ""),
                   os.environ.get("FACEBOOK_GRAPH_VERSION", "v27.0"),
                   os.environ.get("FACEBOOK_LIVE_ENABLED", "false") == "true")


class Supabase:
    def __init__(self, config, opener=None):
        self.config = config
        self.opener = opener or globals()["opener"]()

    def post(self, path, payload):
        headers = {"apikey": self.config.key, "Content-Type": "application/json"}
        # Modern opaque keys are gateway credentials, not JWTs.
        if self.config.key.count(".") == 2 and not self.config.key.startswith("sb_"):
            headers["Authorization"] = "Bearer " + self.config.key
        request = urllib.request.Request(self.config.url.rstrip("/") + path,
                                         data=json.dumps(payload).encode(), headers=headers, method="POST")
        try:
            with self.opener(request, timeout=20) as response:
                return read_json(response)
        except Exception:
            raise TransportError("Supabase request failed") from None

    def rpc(self, name, payload):
        return self.post("/rest/v1/rpc/" + name, payload)

    def signed_url(self, path):
        result = self.post("/storage/v1/object/sign/social-media/" + urllib.parse.quote(path, safe="/"), {"expiresIn": 3600})
        value = result.get("signedURL") or result.get("signedUrl")
        if not isinstance(value, str) or not value or "\\" in value:
            raise TransportError("Invalid signed URL")
        base = self.config.url.rstrip("/")
        if value.startswith("/object/"):
            value = "/storage/v1" + value
        url = urllib.parse.urljoin(base + "/storage/v1/", value)
        parsed = urllib.parse.urlsplit(url)
        expected = urllib.parse.urlsplit(base)
        if parsed.scheme != "https" or parsed.netloc != expected.netloc or parsed.username or parsed.password or parsed.fragment or not parsed.path.startswith("/storage/v1/object/sign/social-media/"):
            raise TransportError("Invalid signed URL origin or path")
        return url


@dataclass
class Result:
    status: str
    error: str = None
    external_post_id: str = None
    published_url: str = None
    delivery_uncertain: bool = False


def validate_content(snapshot):
    """Video-first: companion cover/gallery images remain library assets only.

    They are neither attached to the video nor used as its thumbnail.
    All assets are still validated before selecting the single unique video.
    """
    if snapshot.get("schema_version") != 1:
        raise ValueError("Unsupported snapshot schema")
    destination = snapshot.get("destination", {})
    if destination.get("platform") != "facebook" or not re.fullmatch(r"\d+", str(destination.get("page_id", ""))):
        raise ValueError("Invalid Facebook destination")
    parts = []
    for key in ("title", "description"):
        value = snapshot.get(key)
        if value is not None and not isinstance(value, str):
            raise ValueError("Invalid caption text")
        if value and value.strip():
            parts.append(value.strip())
    price = snapshot.get("price")
    if price is not None:
        try:
            number = Decimal(str(price))
            if not number.is_finite() or number < 0 or number > Decimal("999999999999999"):
                raise InvalidOperation
            parts.append(f"ราคา {number:.2f} บาท")
        except (InvalidOperation, ValueError):
            raise ValueError("Invalid price") from None
    website_url = "https://www.elephant-maker.com/"
    if not any("elephant-maker.com" in p for p in parts):
        parts.append(f"🌐 ดูเพิ่มเติมได้ที่: {website_url}")
    tags = snapshot.get("hashtags") or []
    if isinstance(tags, str):
        tags = tags.split()
    if not isinstance(tags, list) or any(not isinstance(tag, str) for tag in tags):
        raise ValueError("Invalid hashtags")
    normalized = ["#" + tag.strip().lstrip("#") for tag in tags if tag.strip().lstrip("#")]
    if normalized:
        parts.append(" ".join(normalized))
    caption = "\n\n".join(parts)
    if not caption or len(caption) > 63206:
        raise ValueError("Caption is empty or too long")
    assets = snapshot.get("assets", [])
    if not isinstance(assets, list):
        raise ValueError("Invalid assets")
    unique = {}
    for asset in assets:
        if not isinstance(asset, dict):
            raise ValueError("Invalid asset")
        mime = asset.get("mime_type")
        if mime not in ("image/jpeg", "image/png", "video/mp4"):
            raise ValueError("Unsupported media: only JPEG/PNG or MP4")
        size = asset.get("size_bytes")
        maximum = 2 * 1024 ** 3 if mime == "video/mp4" else 10 * 1024 * 1024
        if isinstance(size, bool) or not isinstance(size, int) or not 0 < size <= maximum:
            raise ValueError("Video must be at most 2 GiB" if mime == "video/mp4" else "Image must be at most 10 MiB")
        path = asset.get("object_path")
        if not isinstance(path, str) or "\\" in path or "%" in path or any(p in ("", ".", "..") for p in path.split("/")) or len(path.split("/")) < 2:
            raise ValueError("Invalid private object path")
        try:
            UUID(path.split("/")[0])
        except ValueError:
            raise ValueError("Object path must start with owner UUID") from None
        if any(ord(c) < 32 for c in path):
            raise ValueError("Invalid private object path")
        if path in unique and (unique[path]["mime_type"], unique[path]["size_bytes"]) != (mime, size):
            raise ValueError("Conflicting duplicate asset")
        unique[path] = asset
    videos = [path for path, asset in unique.items() if asset["mime_type"] == "video/mp4"]
    if len(videos) > 1:
        raise ValueError("Unsupported media: more than one unique video")
    if videos:
        return caption, videos[0]
    if len(unique) > 1:
        raise ValueError("Unsupported media: more than one unique media object")
    return caption, next(iter(unique), None)


class Facebook:
    def __init__(self, config, transport=None):
        self.config = config
        self.opener = transport or opener()

    def publish(self, caption, image_url=None, *, video_url=None):
        if video_url:
            # Graph v27 Page Videos supports remote fetch without upload_phase.
            endpoint = "videos"
            payload = {"file_url": video_url, "description": caption, "published": True}
        else:
            endpoint = "photos" if image_url else "feed"
            payload = {"url": image_url, "caption": caption} if image_url else {"message": caption}
        request = urllib.request.Request(
            f"https://graph.facebook.com/{self.config.facebook_version}/{self.config.facebook_page_id}/{endpoint}",
            data=json.dumps(payload).encode(), headers={"Authorization": "Bearer " + self.config.facebook_token, "Content-Type": "application/json"}, method="POST")
        try:
            with self.opener(request, timeout=20) as response:
                result = read_json(response)
            post_id = result.get("post_id") if image_url and not video_url else result.get("id")
            if not isinstance(post_id, str) or not re.fullmatch(r"\d+(?:_\d+)?", post_id):
                raise ValueError("Missing post ID")
            return Result("published", external_post_id=post_id, published_url="https://www.facebook.com/" + post_id)
        except urllib.error.HTTPError as error:
            # Only recognized Graph validation/auth failures are definitive.
            if 400 <= error.code < 500:
                try:
                    with error:
                        graph = read_json(error).get("error", {})
                    code = graph.get("code")
                    if type(code) is int and code in (10, 100, 102, 190, 200, 2500) and not graph.get("is_transient"):
                        return Result("failed", f"Facebook rejected request (code {code})")
                except Exception:
                    pass
            return Result("blocked", "Facebook delivery uncertain", delivery_uncertain=True)
        except Exception:
            return Result("blocked", "Facebook delivery uncertain", delivery_uncertain=True)


def process_target(target, mode):
    """Legacy targets are safe to simulate but never eligible for live dispatch."""
    if mode == "simulation":
        return "simulated", None
    return "blocked", "Legacy snapshot not configured; live publishing blocked"


class Worker:
    def __init__(self, config, transport=None, stop=None, facebook=None):
        self.config = config
        self.transport = transport or Supabase(config)
        self.stop = stop or threading.Event()
        self.facebook = facebook or Facebook(config)

    def process(self, target):
        snapshot = target.get("content_snapshot")
        if snapshot is None:
            if target.get("execution_mode") == "live":
                return Result("blocked", "Legacy live target has no snapshot")
            return Result(*process_target(target, self.config.mode))
        if target.get("platform") != "facebook":
            return Result("blocked", "Snapshot platform is not supported")
        try:
            caption, path = validate_content(snapshot)
        except (ValueError, TypeError, AttributeError) as error:
            # Validation messages are fixed strings, never input values.
            return Result("blocked", str(error) if isinstance(error, ValueError) else "Invalid snapshot")
        mode = snapshot.get("execution_mode")
        if mode not in ("simulation", "live") or target.get("execution_mode") != mode:
            return Result("blocked", "Invalid or conflicting execution mode")
        if mode == "simulation":
            return Result("simulated")
        c = self.config
        if c.mode != "live" or c.facebook_live_enabled is not True or not c.facebook_token or c.lease_seconds < 120:
            return Result("blocked", "Live gates closed: mode, enable flag, token or minimum lease")
        if str(snapshot["destination"]["page_id"]) != c.facebook_page_id:
            return Result("blocked", "Facebook page ID mismatch")
        try:
            url = self.transport.signed_url(path) if path else None
            accepted = self.transport.rpc("begin_target_dispatch", {"p_target_id": target["id"], "p_lease_token": target["lease_token"]})
        except Exception:
            return Result("blocked", "Dispatch preparation failed")
        if accepted is not True:
            return Result("blocked", "Dispatch authorization rejected")
        try:
            selected = next((asset for asset in snapshot.get("assets", []) if asset["object_path"] == path), None)
            if selected and selected["mime_type"] == "video/mp4":
                return self.facebook.publish(caption, video_url=url)
            return self.facebook.publish(caption, url)
        except Exception:
            return Result("blocked", "Facebook delivery uncertain", delivery_uncertain=True)

    def run_once(self):
        try:
            target = self.transport.rpc("claim_target", {"p_lease_seconds": self.config.lease_seconds})
        except Exception:
            LOG.warning("Claim request failed; will retry after polling interval")
            return False
        if target is None:
            return False
        if not isinstance(target, dict) or not target.get("id") or not target.get("lease_token"):
            LOG.error("Invalid claim response; lease will expire")
            return False
        try:
            result = self.process(target)
        except Exception:
            result = Result("failed", "Worker processing failed")
        try:
            accepted = self.transport.rpc("finish_target", {
                "p_target_id": target["id"], "p_lease_token": target["lease_token"],
                "p_status": result.status, "p_error": result.error,
                "p_published_url": result.published_url,
                "p_external_post_id": result.external_post_id,
                "p_delivery_uncertain": result.delivery_uncertain,
            })
            if accepted is not True:
                LOG.warning("Finish rejected; lease expired or superseded")
            else:
                LOG.info("Target finished: %s", result.status)
        except Exception:
            LOG.warning("Finish request failed; lease recovery will handle target")
        return True

    def run(self):
        while not self.stop.is_set():
            self.run_once()
            self.stop.wait(self.config.poll_seconds)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    try:
        config = Config.from_env()
    except (ValueError, TypeError):
        LOG.error("Invalid worker configuration; check required environment variables")
        return 2
    worker = Worker(config)
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: worker.stop.set())
    if args.once:
        worker.run_once()
    else:
        worker.run()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
