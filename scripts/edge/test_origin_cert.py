"""NIN-1-c2: the origin's certificate, needing no renewal — Cloudflare's
Origin CA, served to every edge on 443 (NIN-1-b4).

Run: python3 -m unittest scripts/edge/test_origin_cert.py
"""
import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

SCRIPT = Path(__file__).with_name("origin-cert.sh")
# A stand-in for curl: records each call (argv and the --data body) and
# answers with $FAKE_ANSWER, as Cloudflare's API would.
FAKE_CURL = """#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
data = args[args.index("--data") + 1] if "--data" in args else None
if data and data.startswith("@"):
    data = open(data[1:]).read()
with open(os.environ["FAKE_CALLS"], "a") as f:
    f.write(json.dumps({"args": args, "data": data}) + "\\n")
print(open(os.environ["FAKE_ANSWER"]).read())
"""


def openssl(*args: str) -> str:
    return subprocess.run(["openssl", *args], check=True, capture_output=True, text=True).stdout


class Cloudflare(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = Path(self.tmp.name)
        self.keys, self.calls, self.answer = root / "keys", root / "calls.jsonl", root / "answer.json"
        bin_dir = root / "bin"
        bin_dir.mkdir()
        (bin_dir / "curl").write_text(FAKE_CURL)
        (bin_dir / "curl").chmod(0o755)
        self.env = {**os.environ, "PATH": f"{bin_dir}:{os.environ['PATH']}", "ORIGIN_CERT_KEYS": str(self.keys),
                    "FAKE_CALLS": str(self.calls), "FAKE_ANSWER": str(self.answer),
                    "CLOUDFLARE_API_TOKEN": "tok", "CLOUDFLARE_ZONE_ID": "zone1", "DOMAIN_NAME": "txnet.cyou"}
        self.env.pop("ENV_FILE", None)

    def tearDown(self):
        self.tmp.cleanup()

    def run_cmd(self, *args: str, answer: dict, **env: str) -> subprocess.CompletedProcess:
        self.answer.write_text(json.dumps(answer))
        return subprocess.run([str(SCRIPT), *args], env={**self.env, **env}, capture_output=True, text=True)

    def recorded(self) -> list[dict]:
        return [json.loads(line) for line in self.calls.read_text().splitlines()] if self.calls.exists() else []

    def signed_by_cloudflare(self) -> dict:
        """Cloudflare's answer to the CSR the script sent: here our own self-signed stand-in."""
        cert = Path(self.tmp.name) / "issued.pem"
        openssl("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=stand-in",
                "-keyout", os.devnull, "-out", str(cert))
        return {"success": True, "result": {"id": "c1", "certificate": cert.read_text(),
                                            "expires_on": "2041-10-25 00:00:00 +0000 UTC"}}

    # ADR-0165 point 4: the 443 door's certificate is Cloudflare's Origin CA, 15
    # years, for the zone and every name under it (the platform's hosts and the
    # fallback origin), issued from a CSR so the key never leaves the host.
    def test_a_fifteen_year_origin_ca_certificate_for_the_zone_from_our_csr(self):
        done = self.run_cmd("cloudflare", answer=self.signed_by_cloudflare())
        self.assertEqual(done.returncode, 0, done.stderr)
        (call,) = self.recorded()
        self.assertIn("https://api.cloudflare.com/client/v4/certificates", call["args"])
        self.assertIn("Authorization: Bearer tok", call["args"])
        body = json.loads(call["data"])
        self.assertEqual(body["hostnames"], ["txnet.cyou", "*.txnet.cyou"])
        self.assertEqual((body["request_type"], body["requested_validity"]), ("origin-rsa", 5475))
        key_pub = subprocess.run(["openssl", "pkey", "-pubout", "-in", str(self.keys / "cloudflare.key")],
                                 check=True, capture_output=True, text=True).stdout
        csr_pub = subprocess.run(["openssl", "req", "-noout", "-pubkey"], input=body["csr"],
                                 check=True, capture_output=True, text=True).stdout
        self.assertEqual(key_pub, csr_pub)
        self.assertIn("BEGIN CERTIFICATE", (self.keys / "cloudflare.pem").read_text())
        self.assertEqual((self.keys / "cloudflare.key").stat().st_mode & 0o777, 0o600)

    # A refusal (a token without the SSL permission, say) leaves nothing to seal.
    def test_a_refused_answer_leaves_no_pair(self):
        done = self.run_cmd("cloudflare", answer={"success": False, "errors": [{"code": 10000, "message": "no"}]})
        self.assertNotEqual(done.returncode, 0)
        self.assertFalse((self.keys / "cloudflare.pem").exists())
        self.assertFalse((self.keys / "cloudflare.key").exists())

    def test_an_issued_certificate_is_replaced_only_with_force(self):
        self.run_cmd("cloudflare", answer=self.signed_by_cloudflare())
        refused = self.run_cmd("cloudflare", answer=self.signed_by_cloudflare())
        self.assertEqual(refused.returncode, 1)
        self.assertIn("FORCE=1", refused.stderr)
        self.assertEqual(len(self.recorded()), 1)

    # Full (strict): Cloudflare verifies the origin's certificate on every pull.
    def test_strict_sets_the_zone_to_full_strict(self):
        done = self.run_cmd("strict", answer={"success": True, "result": {"id": "ssl", "value": "strict"}})
        self.assertEqual(done.returncode, 0, done.stderr)
        (call,) = self.recorded()
        self.assertIn("PATCH", call["args"])
        self.assertIn("https://api.cloudflare.com/client/v4/zones/zone1/settings/ssl", call["args"])
        self.assertEqual(json.loads(call["data"]), {"value": "strict"})


if __name__ == "__main__":
    unittest.main()
