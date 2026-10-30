#!/usr/bin/env python3
"""Spec for staging's one way out, the dev bots' gate (OPS-1-ah-j, ADR-0168 point 5).

    python3 tools/k8s_staging_gate_test.py
"""
import base64
import hashlib
import http.server
import json
import sys
import threading
import unittest
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import k8s_staging_gate as kg  # noqa: E402
import staging_botgate as gate  # noqa: E402

TOKEN = "123456:dev"
HASHES = {"telegram": {hashlib.sha256(TOKEN.encode()).hexdigest()}, "bale": set()}


def b64(text: str) -> str:
    return base64.b64encode(text.encode()).decode()


class DecideTest(unittest.TestCase):
    """Only the dev bot's token, and only methods that send or read."""

    def test_the_dev_bot_may_send(self):
        for method in ("sendMessage", "editMessageText", "answerCallbackQuery", "deleteMessage", "getFile",
                       "sendInvoice", "createInvoiceLink"):
            self.assertTrue(gate.decide("telegram", f"/bot{TOKEN}/{method}", HASHES), method)
        self.assertTrue(gate.decide("telegram", f"/file/bot{TOKEN}/photos/a.jpg", HASHES))

    def test_nothing_that_moves_the_bot_or_takes_its_updates(self):
        for method in ("setWebhook", "deleteWebhook", "setMyCommands", "getUpdates", "logOut", "close"):
            self.assertFalse(gate.decide("telegram", f"/bot{TOKEN}/{method}", HASHES), method)

    def test_another_token_or_platform_is_refused(self):
        self.assertFalse(gate.decide("telegram", "/bot999:real/sendMessage", HASHES))
        self.assertFalse(gate.decide("bale", f"/bot{TOKEN}/sendMessage", HASHES))
        self.assertFalse(gate.decide("other", f"/bot{TOKEN}/sendMessage", HASHES))
        self.assertFalse(gate.decide("telegram", f"/bot{TOKEN}/../x/sendMessage", HASHES))


class GateTest(unittest.TestCase):
    """A request through the gate reaches the upstream, or nothing does."""

    def setUp(self):
        self.seen = []
        seen = self.seen

        class Upstream(http.server.BaseHTTPRequestHandler):
            def do_POST(self):
                body = self.rfile.read(int(self.headers["Content-Length"]))
                seen.append((self.path, body, self.headers["Content-Type"]))
                answer = b'{"ok":true}'
                self.send_response(200)
                self.send_header("Content-Length", str(len(answer)))
                self.end_headers()
                self.wfile.write(answer)

            def log_message(self, *args):
                pass

        self.upstream = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        base = f"http://127.0.0.1:{self.upstream.server_address[1]}/host/api.telegram.org"
        self.gate = gate.server(("127.0.0.1", 0), {"telegram": base, "bale": base}, HASHES)
        for s in (self.upstream, self.gate):
            threading.Thread(target=s.serve_forever, daemon=True).start()

    def tearDown(self):
        for s in (self.upstream, self.gate):
            s.shutdown()
            s.server_close()

    def post(self, path: str) -> tuple[int, bytes]:
        request = urllib.request.Request(f"http://127.0.0.1:{self.gate.server_address[1]}{path}",
                                         data=b'{"chat_id":1}', headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(request) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def test_a_send_is_forwarded_whole(self):
        self.assertEqual(self.post(f"/telegram/bot{TOKEN}/sendMessage"), (200, b'{"ok":true}'))
        self.assertEqual(self.seen, [(f"/host/api.telegram.org/bot{TOKEN}/sendMessage", b'{"chat_id":1}',
                                      "application/json")])

    def test_set_webhook_is_answered_by_the_gate_and_never_forwarded(self):
        status, body = self.post(f"/telegram/bot{TOKEN}/setWebhook")
        self.assertEqual(status, 403)
        self.assertFalse(json.loads(body)["ok"])
        self.assertEqual(self.seen, [])


class ServicesTest(unittest.TestCase):
    """Each service's env Secret aimed at the gate, and the guard that checks it."""

    def test_a_secret_naming_a_bot_api_is_aimed_at_the_gate(self):
        patch = kg.secret_patch({"TELEGRAM_API_BASE": b64("https://relay/host/api.telegram.org/"), "X": b64("1")})
        decoded = {k: base64.b64decode(v).decode() for k, v in patch.items()}
        self.assertEqual(decoded, {"TELEGRAM_API_BASE": f"{kg.GATE_URL}/telegram",
                                   "BALE_API_BASE": f"{kg.GATE_URL}/bale", "BOT_WEBHOOK_AUTO_REGISTER": "false"})

    def test_a_secret_with_no_bot_key_is_left_alone(self):
        self.assertEqual(kg.secret_patch({"DATABASE_URL": b64("x")}), {})

    def test_the_guard_names_a_secret_still_aimed_elsewhere(self):
        good = {k: b64(v) for k, v in {"TELEGRAM_API_BASE": f"{kg.GATE_URL}/telegram",
                                       "BALE_API_BASE": f"{kg.GATE_URL}/bale",
                                       "BOT_WEBHOOK_AUTO_REGISTER": "false"}.items()}
        bad = {**good, "BOT_WEBHOOK_AUTO_REGISTER": b64("true")}
        found = kg.findings({"auth-service-env-abc": good, "bot-service-env-def": bad, "other": {}})
        self.assertEqual(found, ["secret bot-service-env-def: BOT_WEBHOOK_AUTO_REGISTER is not 'false'"])


class RunTest(unittest.TestCase):
    """The gate's container: on staging's network at its fixed address, and only
    the tokens' hashes given to it."""

    def test_no_token_reaches_the_container(self):
        argv = kg.run_argv("img", Path("/repo"), {"telegram": "https://t", "bale": "https://b"},
                           {"telegram": [TOKEN], "bale": []})
        self.assertNotIn(TOKEN, " ".join(argv))
        self.assertIn(hashlib.sha256(TOKEN.encode()).hexdigest(), " ".join(argv))
        self.assertIn("/repo/tools/staging_botgate.py:/gate.py:ro", argv)


if __name__ == "__main__":
    unittest.main()
