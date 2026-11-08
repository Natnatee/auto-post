import io
import json
import unittest
import urllib.error
from dataclasses import replace
from unittest.mock import Mock, patch

from worker.main import Config, Facebook, Supabase, TransportError, Worker, validate_content, main


class FacebookTests(unittest.TestCase):
    def config(self, **kwargs):
        return replace(Config("https://example.supabase.co", "sb_secret_PRIVATE", "live",
                              facebook_token="PRIVATE_TOKEN", facebook_page_id="123",
                              facebook_live_enabled=True), **kwargs)

    def target(self, mode="live", assets=None):
        return {"id": "target", "platform": "facebook", "lease_token": "PRIVATE_LEASE", "execution_mode": mode,
                "content_snapshot": {"schema_version": 1, "project_id": "project", "workspace_id": "workspace",
                                     "title": " Title ", "description": "Description", "hashtags": ["sale", "#new"],
                                     "price": 0, "execution_mode": mode,
                                     "destination": {"platform": "facebook", "page_id": "123", "page_name": "Page"},
                                     "assets": assets or []}}

    def asset(self, **kwargs):
        return dict({"id": "asset", "object_path": "11111111-1111-1111-1111-111111111111/image.png",
                     "mime_type": "image/png", "size_bytes": 100, "role": "cover", "position": 0}, **kwargs)

    def response(self, body):
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = json.dumps(body).encode()
        return response

    def run_target(self, target, config=None, finish=True, begin=True):
        transport = Mock()
        transport.rpc.side_effect = lambda name, payload: target if name == "claim_target" else begin if name == "begin_target_dispatch" else finish
        transport.signed_url.return_value = "https://example.supabase.co/storage/v1/object/sign/social-media/image?token=x"
        http = Mock(return_value=self.response({"id": "123_456", "post_id": "123_456"}))
        config = config or self.config()
        Worker(config, transport, facebook=Facebook(config, http)).run_once()
        return transport, http, transport.rpc.call_args.args[1]

    def test_non_facebook_target_cannot_dispatch_a_facebook_snapshot(self):
        target = self.target()
        target["platform"] = "youtube"
        transport, http, finish = self.run_target(target)
        self.assertEqual(finish["p_status"], "blocked")
        http.assert_not_called()
        transport.signed_url.assert_not_called()

    def test_feed_exactly_once_and_finish_seven_fields(self):
        transport, http, finish = self.run_target(self.target())
        http.assert_called_once()
        request = http.call_args.args[0]
        self.assertTrue(request.full_url.endswith("/v27.0/123/feed"))
        self.assertEqual(json.loads(request.data), {"message": "Title\n\nDescription\n\nราคา 0.00 บาท\n\n#sale #new"})
        self.assertEqual(request.get_header("Authorization"), "Bearer PRIVATE_TOKEN")
        self.assertEqual(http.call_args.kwargs["timeout"], 20)
        self.assertEqual([c.args[0] for c in transport.rpc.call_args_list], ["claim_target", "begin_target_dispatch", "finish_target"])
        self.assertEqual(len(finish), 7)
        self.assertEqual(finish["p_status"], "published")
        self.assertEqual(finish["p_external_post_id"], "123_456")
        self.assertEqual(finish["p_published_url"], "https://www.facebook.com/123_456")

    def test_shared_cover_gallery_one_photo(self):
        asset = self.asset()
        transport, http, finish = self.run_target(self.target(assets=[asset, dict(asset, role="gallery")]))
        transport.signed_url.assert_called_once_with(asset["object_path"])
        http.assert_called_once()
        self.assertTrue(http.call_args.args[0].full_url.endswith("/photos"))
        self.assertEqual(set(json.loads(http.call_args.args[0].data)), {"url", "caption"})
        self.assertEqual(finish["p_status"], "published")

    def test_simulation_never_storage_or_facebook_even_live_worker(self):
        transport, http, finish = self.run_target(self.target("simulation", [self.asset()]))
        self.assertEqual(finish["p_status"], "simulated")
        transport.signed_url.assert_not_called()
        http.assert_not_called()
        self.assertEqual(transport.rpc.call_count, 2)

    def test_live_snapshot_never_simulated(self):
        _, http, finish = self.run_target(self.target(), self.config(mode="simulation"))
        self.assertEqual(finish["p_status"], "blocked")
        http.assert_not_called()

    def test_closed_gates_and_mismatch(self):
        for changes in ({"facebook_live_enabled": False}, {"facebook_token": ""}, {"lease_seconds": 119}, {"facebook_page_id": "456"}):
            with self.subTest(changes=changes):
                transport, http, finish = self.run_target(self.target(assets=[self.asset()]), self.config(**changes))
                self.assertEqual(finish["p_status"], "blocked")
                transport.signed_url.assert_not_called()
                http.assert_not_called()

    def test_unsupported_assets_block_both_modes(self):
        cases = [[self.asset(mime_type="video/webm")], [self.asset(), self.asset(object_path="11111111-1111-1111-1111-111111111111/other.jpg")],
                 [self.asset(size_bytes=10485761)], [self.asset(object_path="owner/../image.png")],
                 [self.asset(object_path="11111111-1111-1111-1111-111111111111//x.png")]]
        for mode in ("simulation", "live"):
            for assets in cases:
                transport, http, finish = self.run_target(self.target(mode, assets))
                self.assertEqual(finish["p_status"], "blocked")
                self.assertTrue(finish["p_error"])
                transport.signed_url.assert_not_called()
                http.assert_not_called()

    def test_video_remote_url_and_fencing_order(self):
        asset = self.asset(mime_type="video/mp4", size_bytes=2 * 1024 ** 3)
        target = self.target(assets=[asset, dict(asset, role="video")])
        transport = Mock()
        events = []
        url = "https://example.supabase.co/storage/v1/object/sign/social-media/video?token=PRIVATE"
        transport.signed_url.side_effect = lambda path: events.append("sign") or url
        def rpc(name, payload):
            events.append(name)
            return target if name == "claim_target" else True
        transport.rpc.side_effect = rpc
        def send(request, **kwargs):
            events.append("facebook")
            self.assertEqual(request.full_url, "https://graph.facebook.com/v27.0/123/videos")
            self.assertEqual(json.loads(request.data), {
                "file_url": url, "description": "Title\n\nDescription\n\nราคา 0.00 บาท\n\n#sale #new", "published": True})
            return self.response({"id": "456"})
        http = Mock(side_effect=send)
        Worker(self.config(), transport, facebook=Facebook(self.config(), http)).run_once()
        self.assertEqual(events, ["claim_target", "sign", "begin_target_dispatch", "facebook", "finish_target"])
        transport.signed_url.assert_called_once_with(asset["object_path"])
        http.assert_called_once()
        finish = transport.rpc.call_args.args[1]
        self.assertEqual(finish["p_status"], "published")
        self.assertEqual(finish["p_external_post_id"], "456")
        self.assertFalse(finish["p_delivery_uncertain"])

    def test_video_first_with_cover_and_gallery_in_any_order(self):
        video = self.asset(mime_type="video/mp4", role="video", object_path=self.asset()["object_path"] + ".mp4")
        images = [self.asset(role="cover"),
                  self.asset(role="gallery", mime_type="image/jpeg", object_path=video["object_path"] + ".jpg"),
                  self.asset(role="gallery", object_path=video["object_path"] + ".png")]
        for index in range(4):
            assets = images[:index] + [video] + images[index:]
            target = self.target(assets=assets)
            original = json.dumps(target)
            self.assertEqual(validate_content(target["content_snapshot"])[1], video["object_path"])
            transport, http, finish = self.run_target(target)
            transport.signed_url.assert_called_once_with(video["object_path"])
            http.assert_called_once()
            self.assertTrue(http.call_args.args[0].full_url.endswith("/videos"))
            self.assertEqual(set(json.loads(http.call_args.args[0].data)), {"file_url", "description", "published"})
            self.assertEqual(finish["p_status"], "published")
            self.assertEqual(json.dumps(target), original)
        transport, http, finish = self.run_target(self.target("simulation", images + [video]))
        self.assertEqual(finish["p_status"], "simulated")
        transport.signed_url.assert_not_called()
        http.assert_not_called()

    def test_multiple_unique_videos_block_before_dispatch(self):
        video = self.asset(mime_type="video/mp4", role="video")
        second = dict(video, object_path=video["object_path"] + ".mp4")
        for mode in ("live", "simulation"):
            transport, http, finish = self.run_target(self.target(mode, [self.asset(object_path=video["object_path"] + ".png"), video, second]))
            self.assertEqual(finish["p_status"], "blocked")
            self.assertIn("more than one unique video", finish["p_error"])
            transport.signed_url.assert_not_called()
            http.assert_not_called()
            self.assertNotIn("begin_target_dispatch", [call.args[0] for call in transport.rpc.call_args_list])

    def test_video_validation_and_gates(self):
        video = self.asset(mime_type="video/mp4")
        invalid = [[video, self.asset(mime_type="image/webp", object_path=video["object_path"] + ".webp")],
                   [video, dict(video, size_bytes=101)]]
        invalid.extend([[dict(video, size_bytes=size)] for size in (0, -1, True, 1.5, 2 * 1024 ** 3 + 1)])
        for mode in ("simulation", "live"):
            for assets in invalid:
                transport, http, finish = self.run_target(self.target(mode, assets))
                self.assertEqual(finish["p_status"], "blocked")
                transport.signed_url.assert_not_called()
                http.assert_not_called()
        for config, mode, begin in ((self.config(), "simulation", True),
                                    (self.config(facebook_live_enabled=False), "live", True),
                                    (self.config(), "live", False)):
            transport, http, finish = self.run_target(self.target(mode, [video]), config, begin=begin)
            self.assertEqual(finish["p_status"], "simulated" if mode == "simulation" else "blocked")
            http.assert_not_called()

    def test_video_uncertainty_and_definitive_rejection(self):
        for body in ({}, {"video_id": "456"}, {"id": 456}, {"id": "bad"}):
            result = Facebook(self.config(), Mock(return_value=self.response(body))).publish("caption", video_url="https://signed")
            self.assertEqual((result.status, result.delivery_uncertain), ("blocked", True))
        for status, code, expected, uncertain in ((400, 190, "failed", False),
                                                   (400, 100, "failed", False),
                                                   (500, 100, "blocked", True),
                                                   (400, 389, "blocked", True)):
            error = urllib.error.HTTPError("https://graph.facebook.com", status, "PRIVATE", {},
                                           io.BytesIO(json.dumps({"error": {"code": code}}).encode()))
            result = Facebook(self.config(), Mock(side_effect=error)).publish("caption", video_url="https://signed")
            self.assertEqual((result.status, result.delivery_uncertain), (expected, uncertain))
            self.assertNotIn("PRIVATE", result.error)
        result = Facebook(self.config(), Mock(side_effect=TimeoutError("PRIVATE"))).publish("caption", video_url="https://signed")
        self.assertTrue(result.delivery_uncertain)

    def test_video_preparation_and_finish_failures_never_repost(self):
        target = self.target(assets=[self.asset(mime_type="video/mp4")])
        for signing_fails in (True, False):
            transport = Mock()
            transport.rpc.side_effect = [target, True, TransportError("PRIVATE")]
            transport.signed_url.side_effect = TransportError("PRIVATE") if signing_fails else None
            transport.signed_url.return_value = "https://signed"
            http = Mock(return_value=self.response({"id": "456"}))
            if signing_fails:
                Worker(self.config(), transport, facebook=Facebook(self.config(), http)).run_once()
                http.assert_not_called()
                self.assertEqual(transport.rpc.call_args.args[0], "finish_target")
                self.assertFalse(transport.rpc.call_args.args[1]["p_delivery_uncertain"])
            else:
                with self.assertLogs("worker", "WARNING"):
                    Worker(self.config(), transport, facebook=Facebook(self.config(), http)).run_once()
                http.assert_called_once()

    def test_mode_conflict(self):
        target = self.target()
        target["execution_mode"] = "simulation"
        _, http, finish = self.run_target(target)
        self.assertEqual(finish["p_status"], "blocked")
        http.assert_not_called()

    def test_begin_rejected_no_publish(self):
        _, http, finish = self.run_target(self.target(), begin=False)
        self.assertEqual(finish["p_status"], "blocked")
        http.assert_not_called()

    def test_finish_failure_no_repost(self):
        transport = Mock()
        transport.rpc.side_effect = [self.target(), True, TransportError("safe")]
        http = Mock(return_value=self.response({"id": "123_456"}))
        with self.assertLogs("worker", "WARNING"):
            Worker(self.config(), transport, facebook=Facebook(self.config(), http)).run_once()
        http.assert_called_once()
        self.assertEqual(transport.rpc.call_count, 3)

    def test_graph_failures_and_ambiguous_success(self):
        cases = [(400, {"error": {"code": 190, "message": "PRIVATE_TOKEN"}}, "failed", False),
                 (500, {"error": {"code": 100}}, "blocked", True),
                 (429, {"error": {"code": 4}}, "blocked", True),
                 (400, {"error": {"code": 100, "is_transient": True}}, "blocked", True)]
        for status, body, expected, uncertain in cases:
            error = urllib.error.HTTPError("https://graph.facebook.com", status, "PRIVATE", {}, io.BytesIO(json.dumps(body).encode()))
            result = Facebook(self.config(), Mock(side_effect=error)).publish("text")
            self.assertEqual((result.status, result.delivery_uncertain), (expected, uncertain))
            self.assertNotIn("PRIVATE", result.error)
        for response in ({}, {"id": "photo-only"}, {"post_id": "bad"}):
            result = Facebook(self.config(), Mock(return_value=self.response(response))).publish("text", "https://signed")
            self.assertTrue(result.delivery_uncertain)
        result = Facebook(self.config(), Mock(side_effect=TimeoutError("PRIVATE"))).publish("text")
        self.assertTrue(result.delivery_uncertain)

    def test_signed_url_origin_and_request(self):
        for value in ("/object/sign/social-media/image?token=x", "/storage/v1/object/sign/social-media/image?token=x", "https://example.supabase.co/storage/v1/object/sign/social-media/image?token=x"):
            http = Mock(return_value=self.response({"signedURL": value}))
            url = Supabase(self.config(), http).signed_url(self.asset()["object_path"])
            self.assertTrue(url.startswith("https://example.supabase.co/storage/v1/object/sign/"))
            request = http.call_args.args[0]
            self.assertEqual(request.method, "POST")
            self.assertEqual(json.loads(request.data), {"expiresIn": 3600})
            self.assertIsNone(request.get_header("Authorization"))
        for value in ("https://evil.test/x", "//evil.test/x", "https://example.supabase.co@evil.test/x", "/wrong"):
            with self.assertRaises(TransportError):
                Supabase(self.config(), Mock(return_value=self.response({"signedUrl": value}))).signed_url(self.asset()["object_path"])

    def test_key_headers_env_and_defaults(self):
        for key, authorization in (("sb_secret_PRIVATE", None), ("eyJ.payload.signature", "Bearer eyJ.payload.signature")):
            http = Mock(return_value=self.response(None))
            Supabase(self.config(key=key), http).rpc("claim_target", {})
            self.assertEqual(http.call_args.args[0].get_header("Authorization"), authorization)
        with patch.dict("os.environ", {"SUPABASE_URL": "https://example.supabase.co", "SUPABASE_SECRET_KEY": "sb_secret_new", "SUPABASE_SERVICE_ROLE_KEY": "legacy", "FACEBOOK_LIVE_ENABLED": "TRUE"}, clear=True):
            config = Config.from_env()
            self.assertEqual(config.key, "sb_secret_new")
            self.assertFalse(config.facebook_live_enabled)
            self.assertEqual(config.facebook_version, "v27.0")
            self.assertNotIn("sb_secret_new", repr(config))

    def test_empty_caption_and_invalid_price(self):
        for price in ("NaN", "Infinity", -1):
            snapshot = self.target()["content_snapshot"]
            snapshot["price"] = price
            with self.assertRaises(ValueError):
                validate_content(snapshot)
        snapshot = self.target()["content_snapshot"]
        snapshot.update(title="", description="", hashtags=[], price=None)
        with self.assertRaises(ValueError):
            validate_content(snapshot)

    def test_once_cli_is_bounded_mock_only(self):
        with patch("sys.argv", ["worker", "--once"]), patch("worker.main.Config.from_env", return_value=self.config(mode="simulation")), patch("worker.main.Worker") as worker:
            self.assertEqual(main(), 0)
            worker.return_value.run_once.assert_called_once_with()
            worker.return_value.run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
