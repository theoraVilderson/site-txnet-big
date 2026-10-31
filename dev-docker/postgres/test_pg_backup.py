"""hosting H3, contract.backup.md K20: a missed Sunday full is taken the next night.

Sources pg-backup.sh (PG_BACKUP_SOURCED=1 stops it before the loop) and asks
backup_type for the night's type. Without the catch-up, a stack that is down on
Sunday keeps every WAL segment for another week (dev, 2026-10-25: 5.2 GB).
Run: python3 -m unittest dev-docker/postgres/test_pg_backup.py
"""
import os
import subprocess
import unittest

SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "pg-backup.sh")


def backup_type(weekday, today, newest_full):
    out = subprocess.run(
        ["sh", "-c", '. "$0"; backup_type "$1" "$2" "$3"', SCRIPT, weekday, today, newest_full],
        env={"PATH": os.environ["PATH"], "PG_BACKUP_SOURCED": "1", "TEXTFILE_DIR": "/nonexistent"},
        capture_output=True, text=True, check=True,
    )
    return out.stdout.strip()


class Schedule(unittest.TestCase):
    def test_sunday_is_a_full(self):
        self.assertEqual(backup_type("7", "2026-10-25", "20261018"), "full")

    def test_the_saturday_after_a_full_is_a_diff(self):
        self.assertEqual(backup_type("6", "2026-10-24", "20261018"), "diff")

    def test_a_missed_sunday_makes_the_next_night_a_full(self):
        self.assertEqual(backup_type("4", "2026-10-29", "20261018"), "full")

    def test_a_repository_with_no_full_gets_one(self):
        self.assertEqual(backup_type("3", "2026-10-28", ""), "full")


if __name__ == "__main__":
    unittest.main()
