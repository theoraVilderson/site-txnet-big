#!/usr/bin/env python3
"""Spec for staging's people scrubbed (OPS-1-ah-g, ADR-0168 point 1).

    python3 tools/k8s_staging_people_test.py
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import k8s_staging_people as kp  # noqa: E402


class ColumnsTest(unittest.TestCase):
    """Every phone, email, chat id and payment detail has a fake, and the guard knows it."""

    def test_the_fakes_are_the_adrs(self):
        by_name = {c.name: c for c in kp.COLUMNS}
        self.assertIn("'+98912' || lpad(n::text, 7, '0')", by_name['identity."user".phoneNumber'].fake)
        self.assertIn("@staging.invalid", by_name['identity."user".email'].fake)
        # past Telegram's 52-bit ids, still a safe JS integer
        self.assertIn(str(kp.FAKE_CHAT_BASE), by_name["identity.linked_bot_account.platformUserId"].fake)
        self.assertLess(kp.FAKE_CHAT_BASE, 2 ** 53)
        self.assertGreater(kp.FAKE_CHAT_BASE, 2 ** 52)

    def test_a_unique_column_is_moved_aside_first(self):
        # a fake equal to a row not yet rewritten would break the unique index mid-statement
        sql = kp.scrub_sql()
        aside = 'UPDATE identity."user" SET "phoneNumber" = \'~\' || "phoneNumber" WHERE "phoneNumber" IS NOT NULL;'
        self.assertIn(aside, sql)
        self.assertLess(sql.index(aside), sql.index('UPDATE identity."user" SET "phoneNumber" = \'+98912\''))

    def test_otp_codes_are_deleted_and_it_is_one_transaction(self):
        sql = kp.scrub_sql()
        self.assertTrue(sql.startswith("BEGIN;") and sql.rstrip().endswith("COMMIT;"))
        self.assertIn("DELETE FROM identity.otp_code;", sql)

    def test_payment_details_in_json_are_replaced_key_by_key(self):
        fields = next(c for c in kp.COLUMNS if c.name == "billing.manual_destination.fields")
        for key, fake in kp.DESTINATION_FAKES.items():
            self.assertIn(f"'{key}'", fields.fake)
            self.assertIn(f"'{fake}'", fields.fake)
        # the fakes pass the kinds' own checks (card-to-card.ts: Luhn, sheba mod 97)
        self.assertTrue(luhn(kp.DESTINATION_FAKES["cardNumber"]))
        self.assertTrue(sheba_ok(kp.DESTINATION_FAKES["sheba"]))

    def test_the_guard_counts_what_is_not_ours_in_each_column(self):
        sql = kp.guard_sql()
        for column in kp.COLUMNS:
            self.assertIn(f'NOT ({column.is_fake})', sql)
        self.assertIn("SELECT count(*) FROM identity.otp_code", sql)


class UnknownColumnTest(unittest.TestCase):
    """A contact column the scrub does not know stops staging (ADR-0168, consequences)."""

    def test_a_new_contact_column_is_refused_and_a_known_one_is_not(self):
        found = kp.unknown_columns([("identity", "user", "phoneNumber"), ("support", "ticket", "contactEmail"),
                                    ("audit", "admin_audit_log", "adminIpAddress"), ("network", "panel", "ipAddress")])
        self.assertEqual(found, ["support.ticket.contactEmail"])

    def test_findings_name_each_column_and_its_count(self):
        lines = kp.findings({'identity."user".phoneNumber': 3, "identity.otp_code": 0}, unknown=["x.y.z"])
        self.assertEqual(len(lines), 2)
        self.assertIn("3", lines[0])


class StoresTest(unittest.TestCase):
    def test_redis_keys_naming_a_chat_or_a_phone_are_picked(self):
        keys = ["bot:nav:telegram:i1:1117815196", "txnet:auth:v2:botlink:token:abc",
                "txnet:auth:v2:otp:code:t:login:+989121112244", "rl:signin:+989121112244",
                "rl:signin:mail:a@b.c", "rl:signin:chat:5797569311",
                "session:9f2", "quota:grant:42",
                # dev's Redis, 2026-10-29: a UUID's digits are not a chat id
                "txnet:auth:v2:outbox:processed:panel-tested:live:c1234a56-7890-12c3-a456-789012345678",
                "txnet:auth:v2:outbox:processed:x:12345678-1234-1234-1234-123456789012"]
        self.assertEqual(kp.personal_keys(keys), keys[:6])

    def test_queued_messages_are_dropped(self):
        # they were addressed to real people, and they are published back after the services start
        with tempfile.TemporaryDirectory() as work:
            path = Path(work) / "rabbitmq" / "messages.json"
            path.parent.mkdir()
            path.write_text(json.dumps([{"routing_key": "notification.send", "payload": "+989121112244"}]))
            self.assertEqual(kp.drop_queued(Path(work)), 1)
            self.assertEqual(json.loads(path.read_text()), [])
            self.assertEqual(kp.drop_queued(Path(work) / "none"), 0)


def luhn(digits):
    total = 0
    for i, d in enumerate(int(c) for c in reversed(digits)):
        total += (d * 2 - 9 if d * 2 > 9 else d * 2) if i % 2 else d
    return total % 10 == 0


def sheba_ok(sheba):
    moved = sheba[4:] + sheba[:4]
    return int("".join(str(int(c, 36)) for c in moved)) % 97 == 1


if __name__ == "__main__":
    unittest.main()
