"""OPS-1-o-o (hosting K15, H2): pgBackRest's second repository is S3, beside the first.

Runs pgbackrest-repo.sh with its env and reads back the repo.conf it writes.
Run: python3 -m unittest dev-docker/postgres/test_pgbackrest_repo.py
"""
import os
import subprocess
import tempfile
import unittest

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pgbackrest-repo.sh")
REPO2 = {
    "PG_BACKUP_REPO2_S3_ENDPOINT": "s3.example.test",
    "PG_BACKUP_REPO2_S3_BUCKET": "txnet-pg",
    "PG_BACKUP_REPO2_S3_REGION": "us-east-1",
    "PG_BACKUP_REPO2_S3_KEY": "AKIA",
    "PG_BACKUP_REPO2_S3_SECRET": "s3cret",
}


def settings(conf):
    """repo.conf as {key: value}; section headers dropped."""
    return dict(line.split("=", 1) for line in conf.splitlines() if "=" in line)


class Repo2(unittest.TestCase):
    def write(self, **env):
        work = tempfile.mkdtemp()
        passphrase = os.path.join(work, "passphrase")
        with open(passphrase, "w") as f:
            f.write("open-sesame\n")
        conf = os.path.join(work, "repo.conf")
        done = subprocess.run(["sh", SCRIPT], capture_output=True, text=True, env={
            "PATH": os.environ["PATH"], "POSTGRES_USER": "admin", "PG_BACKUP_PASSPHRASE_FILE": passphrase,
            "PGBACKREST_REPO_CONF": conf, **env})
        return done, (open(conf).read() if os.path.exists(conf) else "")

    def test_without_repo2_only_the_first_repository_is_written(self):
        done, conf = self.write()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertNotIn("repo2-", conf)
        self.assertNotIn("archive-async", conf)

    def test_repo2_is_s3_encrypted_and_kept_as_long_as_the_bucket_locks(self):
        done, conf = self.write(**REPO2)
        self.assertEqual(done.returncode, 0, done.stderr)
        got = settings(conf)
        self.assertEqual(got["repo1-type"], "posix")
        self.assertEqual(got["repo2-type"], "s3")
        self.assertEqual(got["repo2-s3-bucket"], "txnet-pg")
        self.assertEqual(got["repo2-s3-uri-style"], "host")
        self.assertEqual(got["repo2-cipher-type"], "aes-256-cbc")
        self.assertEqual(got["repo2-cipher-pass"], "open-sesame")
        # K15: what expire removes is past its 30-day lock; anything younger it never asks to delete
        self.assertEqual(got["repo2-retention-full-type"], "time")
        self.assertEqual(got["repo2-retention-full"], "30")

    def test_an_s3_outage_never_stops_postgres(self):
        # user 2026-10-24: past the queue's cap WAL is dropped and alerted on, not left to fill the disk
        got = settings(self.write(**REPO2)[1])
        self.assertEqual(got["archive-async"], "y")
        self.assertEqual(got["archive-push-queue-max"], "8GiB")

    def test_path_style_and_the_lock_days_follow_the_env(self):
        got = settings(self.write(**REPO2, PG_BACKUP_REPO2_S3_URI_STYLE="path", PG_BACKUP_REPO2_LOCK_DAYS="45")[1])
        self.assertEqual(got["repo2-s3-uri-style"], "path")
        self.assertEqual(got["repo2-retention-full"], "45")

    def test_a_half_set_repo2_is_refused_by_name(self):
        partial = {k: v for k, v in REPO2.items() if k != "PG_BACKUP_REPO2_S3_SECRET"}
        done, _ = self.write(**partial)
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("PG_BACKUP_REPO2_S3_SECRET", done.stderr)


if __name__ == "__main__":
    unittest.main()
