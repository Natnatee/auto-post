
import threading
import unittest
from unittest.mock import Mock, patch

from worker.main import Config, Supabase, TransportError, Worker


class WorkerTests(unittest.TestCase):
    def config(self, mode="simulation"):
        return Config("https://example.supabase.co", "SECRET_KEY", mode)

    def target(self):
        return {"id": "target", "lease_token": "SECRET_LEASE", "platform": "x",
                "media": [{"object_path": "private/file.mp4"}]}

    def test_simulation_only_claims_and_finishes(self):
        transport = Mock()
        transport.rpc.side_effect = [self.target(), True]
        with patch("urllib.request.urlopen", side_effect=AssertionError("No network")):
            Worker(self.config(), transport).run_once()
        self.assertEqual([c.args[0] for c in transport.rpc.call_args_list], ["claim_target", "finish_target"])
        payload = transport.rpc.call_args_list[1].args[1]
        self.assertEqual(payload["p_status"], "simulated")
        self.assertIsNone(payload["p_published_url"])
        self.assertEqual(payload["p_lease_token"], "SECRET_LEASE")

    def test_live_is_blocked_for_every_platform(self):
        for platform in ("x", "facebook", "tiktok", "youtube"):
            transport = Mock()
            target = self.target()
            target["platform"] = platform
            transport.rpc.side_effect = [target, True]
            Worker(self.config("live"), transport).run_once()
            payload = transport.rpc.call_args_list[1].args[1]
            self.assertEqual(payload["p_status"], "blocked")
            self.assertIn("not configured", payload["p_error"])

    def test_processing_error_finishes_failed_without_secrets(self):
        transport = Mock()
        transport.rpc.side_effect = [self.target(), True]
        with patch("worker.main.process_target", side_effect=RuntimeError("SECRET_KEY SECRET_LEASE")):
            with self.assertLogs("worker", level="INFO") as logs:
                Worker(self.config(), transport).run_once()
        payload = transport.rpc.call_args_list[1].args[1]
        self.assertEqual(payload["p_status"], "failed")
        self.assertNotIn("SECRET", payload["p_error"])
        self.assertNotIn("SECRET", " ".join(logs.output))

    def test_transport_failures_do_not_log_tokens(self):
        for responses in ([RuntimeError("SECRET_KEY")], [self.target(), RuntimeError("SECRET_LEASE")], [self.target(), False]):
            transport = Mock()
            transport.rpc.side_effect = responses
            with self.assertLogs("worker", level="WARNING") as logs:
                Worker(self.config(), transport).run_once()
            self.assertNotIn("SECRET", " ".join(logs.output))

    def test_no_work_and_invalid_claim(self):
        transport = Mock()
        transport.rpc.return_value = None
        self.assertFalse(Worker(self.config(), transport).run_once())
        self.assertEqual(transport.rpc.call_count, 1)
        transport.rpc.return_value = {"id": "target"}
        with self.assertLogs("worker", level="ERROR"):
            self.assertFalse(Worker(self.config(), transport).run_once())

    def test_http_transport_bounded_and_rpc_only(self):
        response = Mock()
        response.__enter__ = Mock(return_value=response)
        response.__exit__ = Mock(return_value=False)
        response.read.return_value = b"null"
        opener = Mock(return_value=response)
        self.assertIsNone(Supabase(self.config(), opener).rpc("claim_target", {"p_lease_seconds": 300}))
        request = opener.call_args.args[0]
        self.assertEqual(request.full_url, "https://example.supabase.co/rest/v1/rpc/claim_target")
        self.assertEqual(opener.call_args.kwargs["timeout"], 20)
        response.read.assert_called_once_with(1048577)

    def test_transport_error_sanitized(self):
        client = Supabase(self.config(), Mock(side_effect=RuntimeError("SECRET_KEY")))
        with self.assertRaises(TransportError) as error:
            client.rpc("claim_target", {})
        self.assertNotIn("SECRET", str(error.exception))

    def test_shutdown_finishes_inflight_then_stops(self):
        stop = threading.Event()
        transport = Mock()
        def rpc(name, payload):
            stop.set()
            return self.target() if name == "claim_target" else True
        transport.rpc.side_effect = rpc
        Worker(self.config(), transport, stop).run()
        self.assertEqual(transport.rpc.call_count, 2)

    def test_configuration_validation(self):
        for kwargs in ({"mode": "invalid"}, {"poll_seconds": 0}, {"lease_seconds": 1}, {"poll_seconds": float("nan")}):
            with self.assertRaises(ValueError):
                Config("https://example.supabase.co", "key", **kwargs)


if __name__ == "__main__":
    unittest.main()
