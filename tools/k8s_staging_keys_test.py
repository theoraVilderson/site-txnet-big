#!/usr/bin/env python3
"""Spec for staging's keys replaced (OPS-1-ah-h, ADR-0168 point 1).

    python3 tools/k8s_staging_keys_test.py
"""
import base64
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import k8s_staging_keys as kk  # noqa: E402

from cryptography.hazmat.primitives.ciphers.aead import AESGCM  # noqa: E402

KEK = bytes(range(32))
TOKEN = "123456:dev-bot-token"
OWNER = "00000000-0000-0000-0000-00000000000a"
DEV_ENV = {"TELEGRAM_BOT_TOKEN": TOKEN, "TELEGRAM_BOT_USERNAME": "txnet_dev_bot",
           "TELEGRAM_WEBHOOK_SECRET": "s3cret", "BALE_BOT_TOKEN": "", "BALE_BOT_USERNAME": "x"}


def opened(sealed: kk.Sealed, key: bytes) -> str:
    raw = base64.b64decode(sealed.ciphertext) + base64.b64decode(sealed.auth_tag)
    return AESGCM(key).decrypt(base64.b64decode(sealed.iv), raw, None).decode()


class VaultTest(unittest.TestCase):
    """What the Node vault (vault.crypto.ts) reads back: AES-256-GCM, base64, its fingerprint."""

    def test_a_sealed_value_opens_under_its_key(self):
        sealed = kk.seal(TOKEN, KEK)
        self.assertEqual(opened(sealed, KEK), TOKEN)
        self.assertEqual(len(base64.b64decode(sealed.iv)), 12)
        self.assertNotEqual(kk.seal(TOKEN, KEK).iv, sealed.iv)

    def test_the_fingerprint_is_the_vaults(self):
        # sha256("txnet:vault:fingerprint:v1" \0 "abc"), 16 hex: the value Node computes
        self.assertEqual(kk.fingerprint("abc"), "8b64600dc01ecc16")

    def test_the_kek_is_read_as_the_vault_reads_it(self):
        self.assertEqual(kk.parse_key(KEK.hex()), KEK)
        self.assertEqual(kk.parse_key(base64.b64encode(KEK).decode() + "\n"), KEK)
        with self.assertRaises(ValueError):
            kk.parse_key("c2hvcnQ=")

    def test_a_dek_is_wrapped_as_iv_tag_ciphertext(self):
        dek = bytes(32)
        iv, tag, ct = kk.wrap(dek, KEK).split(".")
        self.assertEqual(opened(kk.Sealed(ct, iv, tag), KEK), base64.b64encode(dek).decode())


class DevBotsTest(unittest.TestCase):
    """The dev bots come from .env.dev, as scripts/seed-bot-integration.sh reads them."""

    def test_a_platform_with_no_token_has_no_dev_bot(self):
        bots = kk.dev_bots(DEV_ENV)
        self.assertEqual([b.platform for b in bots], ["telegram"])
        self.assertEqual((bots[0].username, bots[0].secret), ("txnet_dev_bot", "s3cret"))

    def test_an_unset_webhook_secret_is_derived_from_the_token(self):
        # the guard runs in another process and must know it again
        bot = kk.dev_bots({**DEV_ENV, "TELEGRAM_WEBHOOK_SECRET": ""})[0]
        self.assertEqual(bot.secret, kk.dev_bots({**DEV_ENV, "TELEGRAM_WEBHOOK_SECRET": ""})[0].secret)
        self.assertRegex(bot.secret, r"^[A-Za-z0-9_-]{32}$")


class ScrubTest(unittest.TestCase):
    """Every real key goes; the platform's primary bot gets the dev bot."""

    def setUp(self):
        self.sql = kk.keys_sql(kk.dev_bots(DEV_ENV), KEK)

    def test_every_vault_key_but_the_panels_logins_is_deleted(self):
        self.assertIn("DELETE FROM tenant.tenant_credential WHERE kind <> 'panel_credentials';", self.sql)
        self.assertTrue(self.sql.startswith("BEGIN;") and self.sql.rstrip().endswith("COMMIT;"))

    def test_every_bot_but_the_platforms_primary_on_a_dev_platform_is_disabled(self):
        self.assertIn("SET status = 'disabled'", self.sql)
        self.assertIn("platform IN ('telegram')", self.sql)
        self.assertIn("\"botUsername\" = 'txnet_dev_bot'", self.sql)

    def test_the_token_is_written_sealed_never_in_clear(self):
        self.assertNotIn(TOKEN, self.sql)
        self.assertNotIn("s3cret", self.sql)
        self.assertIn("'telegram_bot_token'", self.sql)
        self.assertIn("'webhook_secret'", self.sql)
        self.assertIn(kk.fingerprint(TOKEN), self.sql)

    def test_gateway_keys_are_cleared(self):
        self.assertIn('UPDATE tenant.tenant_gateway_config SET "merchantIdEncrypted" = NULL, '
                      '"apiKeyEncrypted" = NULL', self.sql)
        self.assertIn(f"UPDATE billing.payment_gateway SET \"merchantId\" = '{kk.WIPED}'", self.sql)

    def test_with_no_dev_bot_every_bot_is_disabled_and_no_key_is_made(self):
        sql = kk.keys_sql([], KEK)
        self.assertNotIn("tenant_dek", sql)
        self.assertIn("UPDATE automation.bot_integration SET status = 'disabled';", sql)


class GuardTest(unittest.TestCase):
    """The guard refuses any key that is not staging's own."""

    bots = kk.dev_bots(DEV_ENV)

    def state(self, **over):
        state = {"owner": OWNER, "vault": [], "bots": [], "gateway_keys": 0, "merchant_ids": 0, "columns": []}
        return {**state, **over}

    def test_a_clean_copy_passes(self):
        vault = [{"tenantId": OWNER, "kind": "telegram_bot_token", "fingerprint": kk.fingerprint(TOKEN)},
                 {"tenantId": OWNER, "kind": "webhook_secret", "fingerprint": kk.fingerprint("s3cret")}]
        bots = [{"tenantId": OWNER, "platform": "telegram", "role": "primary", "status": "active",
                 "botUsername": "txnet_dev_bot"},
                {"tenantId": "r", "platform": "telegram", "role": "primary", "status": "disabled",
                 "botUsername": "real_bot"}]
        self.assertEqual(kk.findings(self.state(vault=vault, bots=bots), self.bots), [])

    def test_a_real_key_in_the_vault_is_refused(self):
        vault = [{"tenantId": OWNER, "kind": "sms_api_key", "fingerprint": "f"},
                 {"tenantId": "r", "kind": "telegram_bot_token", "fingerprint": kk.fingerprint(TOKEN)}]
        found = kk.findings(self.state(vault=vault), self.bots)
        self.assertEqual(len(found), 2)
        self.assertIn("sms_api_key", found[0])

    def test_a_bot_in_service_that_is_not_the_dev_bot_is_refused(self):
        bots = [{"tenantId": "r", "platform": "telegram", "role": "primary", "status": "error",
                 "botUsername": "real_bot"}]
        self.assertIn("real_bot", kk.findings(self.state(bots=bots), self.bots)[0])

    def test_gateway_keys_left_are_refused(self):
        self.assertEqual(len(kk.findings(self.state(gateway_keys=2, merchant_ids=1), self.bots)), 2)

    def test_an_unknown_key_column_is_refused(self):
        columns = [["billing", "payment_gateway", "webhookSecret"], ["identity", "user", "passwordHash"]]
        found = kk.findings(self.state(columns=columns), self.bots)
        self.assertEqual(found, ["billing.payment_gateway.webhookSecret: may hold a key the scrub does not know "
                                 "(add it to KEY_COLUMNS or NOT_KEY)"])


if __name__ == "__main__":
    unittest.main()
