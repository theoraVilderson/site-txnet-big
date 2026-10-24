#!/usr/bin/env python3
"""Spec for secrets on Kubernetes (OPS-1-o-j, hosting K5, contract.secrets.md).

The env files and secret files the render reads are committed SOPS-encrypted
to an age key, opened only in memory on the node, and rendered from there.

    python3 tools/k8s_secrets_test.py      (the round trips need sops and age-keygen on PATH)
"""
import base64
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).parent))
sys.path.insert(0, str(Path(__file__).parent.parent / "scripts/bundle"))
import bundle_plan as bp  # noqa: E402
import k8s_secrets as ks  # noqa: E402
from k8srender import RenderError, render  # noqa: E402
from k8srender.sealed import NEVER_SEALED, secret_files, sealed_path  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
OPTIONS = {"registry": "registry.example", "tag": "t1"}
HAVE_SOPS = bool(shutil.which("sops") and shutil.which("age-keygen"))


def model(repo: Path) -> dict:
    """Two services binding a key file each, a compose `secrets:` file, and a config that is not secret."""
    return {
        "secrets": {"bale_token": {"file": str(repo / "dev-docker/monitoring/config-dev/bale_token.txt")}},
        "services": {
            "auth-service": {
                "image": "txnet/auth:1",
                "volumes": [
                    {"type": "bind", "source": str(repo / "dev-docker/secrets/vault-kek"),
                     "target": "/run/secrets/vault-kek", "read_only": True},
                    {"type": "bind", "source": str(repo / "dev-docker/pgbouncer/pgbouncer.ini"),
                     "target": "/etc/pgbouncer.ini", "read_only": True},
                ],
            },
            "alertmanager": {"image": "prom/alertmanager:v0.27.0", "secrets": [{"source": "bale_token"}]},
        },
    }


def write(path: Path, text: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return path


class SealedPathTest(unittest.TestCase):
    # `.env*` is ignored by git; a sealed copy named so would never be committed.
    def test_a_leading_dot_is_spelt_out(self):
        self.assertEqual(sealed_path(".env.prod"), "k8s/sealed/dotenv.prod.sops")
        self.assertEqual(sealed_path("dev-docker/monitoring/.env.prod"), "k8s/sealed/dev-docker/monitoring/dotenv.prod.sops")
        self.assertEqual(sealed_path("dev-docker/secrets/vault-kek"), "k8s/sealed/dev-docker/secrets/vault-kek.sops")

    @unittest.skipUnless(shutil.which("git"), "needs git")
    def test_no_sealed_path_is_ignored_by_git(self):
        paths = [sealed_path(p) for p in (".env", ".env.prod", "dev-docker/monitoring/.env.prod",
                                          "dev-docker/secrets/vault-kek", "dev-docker/monitoring/config-dev/bale_token.txt")]
        ignored = subprocess.run(["git", "-C", str(REPO), "check-ignore", *paths], capture_output=True, text=True).stdout
        self.assertEqual(ignored, "")


class SecretFilesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        write(self.repo / "dev-docker/secrets/vault-kek", "kek\n")
        write(self.repo / "dev-docker/pgbouncer/pgbouncer.ini", "[pgbouncer]\n")
        write(self.repo / "dev-docker/monitoring/config-dev/bale_token.txt", "123:abc\n")
        self.model = model(self.repo)

    def tearDown(self):
        self.tmp.cleanup()

    # Derived from the model: a key file bound tomorrow is sealed without an edit here.
    def test_what_is_sealed_is_what_the_render_reads_as_secret(self):
        self.assertEqual(secret_files(self.model, self.repo),
                         ["dev-docker/monitoring/config-dev/bale_token.txt", "dev-docker/secrets/vault-kek"])

    # B5: the age key rides in the bundle, so the bundle's passphrase sealed in
    # the repo would let a bundle open itself.
    def test_the_bundle_passphrase_is_never_sealed(self):
        self.assertIn(bp.PASSPHRASE_FILE, NEVER_SEALED)
        self.model["services"]["auth-service"]["volumes"].append(
            {"type": "bind", "source": str(self.repo / bp.PASSPHRASE_FILE), "target": "/run/secrets/p"})
        with self.assertRaisesRegex(RenderError, "backup-bundle-passphrase"):
            secret_files(self.model, self.repo)

    def test_a_render_from_sealed_files_reads_them_not_the_checkout(self):
        sealed = Path(self.tmp.name, "opened")
        write(sealed / "dev-docker/secrets/vault-kek", "from-sealed\n")
        write(sealed / "dev-docker/monitoring/config-dev/bale_token.txt", "999:sealed\n")
        files = render(self.model, self.repo, {**OPTIONS, "sealed_root": sealed})
        data = {k: base64.b64decode(v).decode() for o in files["files.yaml"] if o["kind"] == "Secret"
                for k, v in o["data"].items()}
        self.assertEqual(data, {"vault-kek": "from-sealed\n", "bale_token": "999:sealed\n"})
        # A file that is not secret still comes from the checkout.
        self.assertTrue(any(o["kind"] == "ConfigMap" for o in files["files.yaml"]))

    # Opened only from what is sealed: a key file missing there is not read from disk instead.
    def test_a_secret_file_that_is_not_sealed_fails_the_render(self):
        sealed = Path(self.tmp.name, "opened")
        write(sealed / "dev-docker/monitoring/config-dev/bale_token.txt", "999:sealed\n")
        with self.assertRaisesRegex(RenderError, r"dev-docker/secrets/vault-kek is not sealed"):
            render(self.model, self.repo, {**OPTIONS, "sealed_root": sealed})


@unittest.skipUnless(HAVE_SOPS, "needs sops and age-keygen on PATH")
class RoundTripTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.key = self.root / "keys/age.key"
        self.env = {**os.environ, "SOPS_AGE_KEY_FILE": str(self.key)}

    def tearDown(self):
        self.tmp.cleanup()

    def test_init_makes_one_key_and_names_it_as_the_recipient(self):
        recipient = ks.init(self.root, self.key)
        self.assertEqual(oct(self.key.stat().st_mode & 0o777), "0o600")
        rules = yaml.safe_load((self.root / ".sops.yaml").read_text())["creation_rules"]
        self.assertEqual(rules[0]["age"], recipient)
        with self.assertRaises(ks.SecretsError):
            ks.init(self.root, self.key)  # a second key would orphan every sealed file

    def test_sealed_files_open_byte_for_byte_and_hold_no_plaintext(self):
        ks.init(self.root, self.key)
        text = "A=1\n# a comment sops's dotenv parser rejects:     # e.g. \"x,y\"\nB=two words\n"
        write(self.root / ".env.prod", text)
        ks.seal(self.root, [".env.prod"], env=self.env)
        sealed = (self.root / sealed_path(".env.prod")).read_text()
        self.assertNotIn("two words", sealed)
        opened = self.root / "opened"
        ks.open_files(self.root, [".env.prod"], opened, env=self.env)
        self.assertEqual((opened / ".env.prod").read_text(), text)


    # Rotation is `sops edit`; the plaintext left on disk is then stale, and a
    # bare seal must not write it back over the rotated value.
    def test_a_sealed_copy_is_replaced_only_when_named(self):
        ks.init(self.root, self.key)
        write(self.root / "dev-docker/secrets/vault-kek", "old\n")
        ks.seal(self.root, ["dev-docker/secrets/vault-kek"], env=self.env)
        write(self.root / "dev-docker/secrets/vault-kek", "stale\n")
        self.assertEqual(ks.seal(self.root, ["dev-docker/secrets/vault-kek"], env=self.env, replace=False), [])
        opened = self.root / "opened"
        ks.open_files(self.root, ["dev-docker/secrets/vault-kek"], opened, env=self.env)
        self.assertEqual((opened / "dev-docker/secrets/vault-kek").read_text(), "old\n")
        self.assertEqual(ks.seal(self.root, ["dev-docker/secrets/vault-kek"], env=self.env, replace=True),
                         ["dev-docker/secrets/vault-kek"])


# K1, K5: the server's flags, in the file k3s reads at install (OPS-1-o-f).
class K3sConfigTest(unittest.TestCase):
    def test_secrets_are_encrypted_at_rest(self):
        config = yaml.safe_load((REPO / "k8s/k3s/config.yaml").read_text())
        self.assertIs(config["secrets-encryption"], True)
        self.assertEqual(config["disable"], ["traefik"])


# K5, B5: the age key rides in the bundle; it lives outside the checkout.
class BundleTest(unittest.TestCase):
    def test_the_age_key_is_carried(self):
        self.assertIn(ks.AGE_KEY_FILE, bp.KEY_FILES)
        self.assertTrue(os.path.isabs(ks.AGE_KEY_FILE))

    def test_an_absolute_key_is_archived_from_the_filesystem_root(self):
        self.assertEqual(bp.key_tar_args("/srv/txnet", [".env", "/etc/txnet/age.key", "dev-docker/secrets/vault-kek"]),
                         ["-C", "/srv/txnet", ".env", "dev-docker/secrets/vault-kek", "-C", "/", "etc/txnet/age.key"])

    def test_relative_keys_alone_need_one_directory(self):
        self.assertEqual(bp.key_tar_args("/srv/txnet", [".env"]), ["-C", "/srv/txnet", ".env"])


if __name__ == "__main__":
    unittest.main()
