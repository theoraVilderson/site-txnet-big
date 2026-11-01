"""F-018-m2-c (object-storage contract, "Backup and disk"): the nightly locked copy of the files.

Runs object-backup.sh --now against a stand-in `mc` on PATH that logs each call;
the source and the backup each list as empty or not, per test.
Run: python3 -m unittest dev-docker/backup/test_object_backup.py
"""
import os
import subprocess
import tempfile
import unittest

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "object-backup.sh")
# `ls` prints one line for a side named in STUB_FULL (src, dst); `retention set`
# on an empty prefix fails as the real mc does ("Unable to find any object").
STUB_MC = """#!/bin/sh
echo "$*" >> "$STUB_LOG"
case "$1" in
  ls) case "$3" in dst/*) side=dst ;; *) side=src ;; esac
      case " $STUB_FULL " in *" $side "*) echo "[2026-11-01] 1KiB a.png" ;; esac ;;
  retention) case " $STUB_FULL " in *" dst "*) exit 0 ;; *) echo "mc: <ERROR> Unable to find any object/version to set its retention." >&2; exit 1 ;; esac ;;
esac
exit 0
"""
BUCKET = {
    "OBJECT_BACKUP_S3_ENDPOINT": "https://s3.example.test",
    "OBJECT_BACKUP_S3_BUCKET": "txnet-backups",
    "OBJECT_BACKUP_S3_ACCESS_KEY_ID": "AKIA",
    "OBJECT_BACKUP_S3_SECRET_ACCESS_KEY": "s3cret",
    "OBJECT_BACKUP_S3_PREFIX": "objects/test/",
    "OBJECT_BACKUP_S3_LOCK_DAYS": "7",
}


class NightlyRun(unittest.TestCase):
    def run_now(self, full):
        work = tempfile.mkdtemp()
        with open(os.path.join(work, "mc"), "w") as f:
            f.write(STUB_MC)
        os.chmod(os.path.join(work, "mc"), 0o755)
        log = os.path.join(work, "calls")
        done = subprocess.run(["sh", SCRIPT, "--now"], capture_output=True, text=True, env={
            "PATH": work + os.pathsep + os.environ["PATH"], "STUB_LOG": log, "STUB_FULL": full,
            "TEXTFILE_DIR": work, **BUCKET})
        with open(os.path.join(work, "object_backup.prom")) as f:
            metrics = f.read()
        with open(log) as f:
            calls = f.read()
        return done, metrics, calls

    def test_no_files_at_all_is_a_success_with_nothing_to_lock(self):
        # production 2026-10-31: no file uploaded yet, and every night reported FAILED
        done, metrics, calls = self.run_now(full="")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("txnet_object_backup_last_run_success 1", metrics)
        self.assertNotIn("retention", calls)

    def test_copied_files_are_locked(self):
        done, metrics, calls = self.run_now(full="src dst")
        self.assertEqual(done.returncode, 0, done.stdout + done.stderr)
        self.assertIn("retention set --recursive --quiet compliance 7d dst/txnet-backups/objects/test", calls)
        self.assertIn("txnet_object_backup_last_run_success 1", metrics)

    def test_an_empty_source_beside_a_full_backup_is_refused(self):
        done, metrics, calls = self.run_now(full="dst")
        self.assertEqual(done.returncode, 1)
        self.assertIn("txnet_object_backup_last_run_success 0", metrics)
        self.assertNotIn("mirror", calls)


if __name__ == "__main__":
    unittest.main()
