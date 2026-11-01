#!/usr/bin/env python3
"""Spec for `staging.sh bots`: the owner talks to staging's bots (OPS-1-ah-p, hosting R18).

    python3 tools/k8s_staging_bots_test.py
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import k8s_staging_bots as kb  # noqa: E402
import k8s_staging_keys as kk  # noqa: E402

OWNERS = frozenset({("telegram", "5797569311"), ("bale", "1153674618")})
TELEGRAM = kk.DevBot("telegram", "1:tok", "dev_bot", "s3cret")


def update(kind: str, sender: int, update_id: int = 7) -> dict:
    return {"update_id": update_id, kind: {"from": {"id": sender}, "chat": {"id": sender}}}


class RouteTest(unittest.TestCase):
    """Only an update one of the owner's chats sent reaches staging."""

    def test_the_sender_is_read_from_any_kind_of_update(self):
        self.assertEqual(kb.sender(update("message", 5797569311)), "5797569311")
        self.assertEqual(kb.sender(update("callback_query", 42)), "42")
        self.assertIsNone(kb.sender({"update_id": 1, "poll": {"id": "x"}}))

    def test_an_owners_update_is_passed_and_anyone_elses_dropped(self):
        self.assertTrue(kb.from_owner("telegram", update("message", 5797569311), OWNERS))
        self.assertFalse(kb.from_owner("telegram", update("message", 1153674618), OWNERS))  # bale's id, not telegram's
        self.assertFalse(kb.from_owner("bale", update("message", 99), OWNERS))


class WebhookTest(unittest.TestCase):
    """The dev bot's webhook is recorded before it is removed, and set back as it was."""

    def setUp(self):
        self.calls = []
        self.state = Path(tempfile.mkdtemp()) / "bots.json"

        def call(bot, method, params=None):
            self.calls.append((bot.platform, method, params or {}))
            if method == "getWebhookInfo":
                return {"url": "https://api.dev/api/bots/telegram/abc", "allowed_updates": ["message"]}
            return True
        self.call = call

    def test_recorded_then_removed(self):
        kb.take([TELEGRAM], self.call, self.state)
        self.assertEqual([m for _, m, _ in self.calls], ["getWebhookInfo", "deleteWebhook"])
        self.assertEqual(json.loads(self.state.read_text()),
                         {"telegram": {"url": "https://api.dev/api/bots/telegram/abc", "allowed_updates": ["message"]}})

    def test_set_back_with_the_dev_bots_own_secret_and_the_record_spent(self):
        kb.take([TELEGRAM], self.call, self.state)
        self.calls.clear()
        kb.give_back([TELEGRAM], self.call, self.state)
        self.assertEqual(self.calls, [("telegram", "setWebhook", {"url": "https://api.dev/api/bots/telegram/abc",
                                                                  "secret_token": "s3cret",
                                                                  "allowed_updates": ["message"]})])
        self.assertFalse(self.state.exists())

    def test_nothing_recorded_is_nothing_to_set_back(self):
        kb.give_back([TELEGRAM], self.call, self.state)
        self.assertEqual(self.calls, [])

    def test_a_bot_with_no_webhook_is_left_with_none(self):
        self.state.write_text(json.dumps({"telegram": {"url": "", "allowed_updates": []}}))
        kb.give_back([TELEGRAM], self.call, self.state)
        self.assertEqual(self.calls, [])


class DeliverTest(unittest.TestCase):
    def test_posted_to_bot_services_own_webhook_route_with_the_secret(self):
        url, headers = kb.delivery(3999, "telegram", "abc", "s3cret")
        self.assertEqual(url, "http://127.0.0.1:3999/api/bots/telegram/abc")
        self.assertEqual(headers["X-Telegram-Bot-Api-Secret-Token"], "s3cret")


if __name__ == "__main__":
    unittest.main()
