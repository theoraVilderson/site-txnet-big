"""NIN-1-c1: the domestic door's certificate, from our own origin CA, needing no renewal.

Run: python3 -m unittest scripts/edge/test_origin_cert.py
"""
import os
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

SCRIPT = Path(__file__).with_name("origin-cert.sh")
TEN_YEARS = timedelta(days=3650)


def openssl(*args: str) -> str:
    return subprocess.run(["openssl", *args], check=True, capture_output=True, text=True).stdout


class Domestic(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.keys = Path(self.tmp.name)
        self.env = {**os.environ, "ORIGIN_CERT_KEYS": str(self.keys)}

    def tearDown(self):
        self.tmp.cleanup()

    def issue(self, *extra_env: tuple[str, str]) -> subprocess.CompletedProcess:
        return subprocess.run([str(SCRIPT), "domestic", "barghgho.ir"], env={**self.env, **dict(extra_env)},
                              capture_output=True, text=True)

    def end_of(self, name: str) -> datetime:
        line = openssl("x509", "-in", str(self.keys / name), "-noout", "-enddate").strip()
        return datetime.strptime(line.removeprefix("notAfter="), "%b %d %H:%M:%S %Y %Z").replace(tzinfo=timezone.utc)

    # ADR-0165 point 4: nothing renews it online, so it lasts ten years; the
    # domain and every name under it, for a server, signed by our CA.
    def test_a_ten_year_server_certificate_for_the_domain_signed_by_our_ca(self):
        self.assertEqual(self.issue().returncode, 0)
        left = self.end_of("domestic.pem") - datetime.now(timezone.utc)
        self.assertLess(abs(left - TEN_YEARS), timedelta(days=1))
        text = openssl("x509", "-in", str(self.keys / "domestic.pem"), "-noout", "-text")
        self.assertIn("DNS:barghgho.ir, DNS:*.barghgho.ir", text)
        self.assertIn("TLS Web Server Authentication", text)
        self.assertNotIn("CA:TRUE", text)
        openssl("verify", "-CAfile", str(self.keys / "ca.pem"), str(self.keys / "domestic.pem"))
        self.assertGreater(self.end_of("ca.pem"), self.end_of("domestic.pem"))

    # The key is the gateway's alone: owner-only on the host (sealing copies it).
    def test_the_keys_are_owner_only(self):
        self.issue()
        for name in ("ca.key", "domestic.key"):
            self.assertEqual((self.keys / name).stat().st_mode & 0o777, 0o600, name)

    # A sealed certificate replaced by accident would be deployed as is.
    def test_an_issued_certificate_is_replaced_only_with_force(self):
        self.issue()
        first = (self.keys / "domestic.pem").read_bytes()
        refused = self.issue()
        self.assertEqual(refused.returncode, 1)
        self.assertIn("FORCE=1", refused.stderr)
        self.assertEqual((self.keys / "domestic.pem").read_bytes(), first)

    # Re-issuing keeps the CA, so a door that later trusts it need not change.
    def test_force_re_issues_under_the_same_ca(self):
        self.issue()
        ca, first = (self.keys / "ca.pem").read_bytes(), (self.keys / "domestic.pem").read_bytes()
        self.assertEqual(self.issue(("FORCE", "1")).returncode, 0)
        self.assertEqual((self.keys / "ca.pem").read_bytes(), ca)
        self.assertNotEqual((self.keys / "domestic.pem").read_bytes(), first)

    def test_a_domain_is_required(self):
        missing = subprocess.run([str(SCRIPT), "domestic"], env=self.env, capture_output=True, text=True)
        self.assertNotEqual(missing.returncode, 0)
        self.assertFalse((self.keys / "domestic.pem").exists())


if __name__ == "__main__":
    unittest.main()
