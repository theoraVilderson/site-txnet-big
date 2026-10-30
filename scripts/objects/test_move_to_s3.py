"""F-018-m2-d: the stored files move to the bucket, each checked by its sha256.

Run: python3 -m unittest scripts/objects/test_move_to_s3.py
"""
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import move_to_s3 as mv  # noqa: E402

KEY = "tenants/11111111-1111-4111-8111-111111111111/support/a.png"
SHA = "a" * 64


class Rows(unittest.TestCase):
    def test_psql_lines_become_key_and_sha256(self):
        text = "%s %s\n\ntenants/x/b.pdf %s\n" % (KEY, SHA, "b" * 64)
        self.assertEqual(mv.parse_rows(text), [(KEY, SHA), ("tenants/x/b.pdf", "b" * 64)])

    def test_a_line_that_is_not_a_key_and_a_digest_stops_the_check(self):
        with self.assertRaises(ValueError):
            mv.parse_rows("%s not-a-digest\n" % KEY)

    def test_the_check_reads_its_keys_on_stdin_one_per_line(self):
        self.assertEqual(mv.rows_input([(KEY, SHA)]), "%s %s\n" % (KEY, SHA))


class Verdict(unittest.TestCase):
    def test_every_line_is_counted_and_a_bad_key_is_named(self):
        out = "OK %s\nREPAIRED tenants/x/b.pdf\nBAD tenants/x/c.png\nsomething mc said\n" % KEY
        self.assertEqual(mv.verdict(out), {"ok": 1, "repaired": 1, "bad": ["tenants/x/c.png"]})

    def test_a_row_the_check_never_answered_is_bad(self):
        # A check that died half-way must not read as a clean move.
        self.assertEqual(mv.verdict("OK %s\n" % KEY, expected=2)["bad"], ["(1 row(s) never checked)"])


class Copy(unittest.TestCase):
    def test_the_copy_never_overwrites_or_deletes_in_the_bucket(self):
        # After the switch a user may replace a file in the bucket; the volume's
        # older bytes must not land over it. A key whose bytes differ is the
        # check's to repair, and only from bytes that match the row.
        script = mv.COPY_SCRIPT
        self.assertIn("mc mirror", script)
        self.assertNotIn("--overwrite", script)
        self.assertNotIn("--remove", script)
        self.assertIn("--exclude '*.tmp'", script)


if __name__ == "__main__":
    unittest.main()
