"""OPS-1-ad: one encrypted file holds the whole platform, and comes back whole.

Run: python3 -m unittest scripts/bundle/test_bundle.py
"""
import datetime
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(__file__))
import bundle_plan as bp  # noqa: E402

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(__file__)), "move"))
import move_figures as mf  # noqa: E402
import move_plan as mp  # noqa: E402

WHEN = datetime.datetime(2026, 10, 23, 15, 30, 12, tzinfo=datetime.timezone.utc)


def names(*days):
    return [bp.bundle_name("devtxnet", WHEN.replace(day=d)) for d in days]


class Names(unittest.TestCase):
    def test_the_name_carries_the_stack_the_date_and_the_time(self):
        name = bp.bundle_name("devtxnet", WHEN)
        self.assertEqual(name, "txnet-backup-devtxnet-2026-10-23_15-30-12Z.tar.zst.gpg")
        self.assertEqual(bp.bundle_time(name), WHEN)

    def test_other_files_are_not_bundles(self):
        for other in ("notes.txt", "txnet-backup-devtxnet-2026-10-23_15-30-12Z.tar.zst.gpg.partial",
                      "txnet-backup-devtxnet-2026-10-23_15-30-12Z.tar.zst.gpg.sha256"):
            self.assertIsNone(bp.bundle_time(other))


class Retention(unittest.TestCase):
    def test_the_newest_are_kept_and_the_oldest_go(self):
        all_names = names(10, 11, 12, 13, 14, 15, 16, 17, 18)
        self.assertEqual(bp.to_prune(all_names, shipped=set(all_names), shipping_configured=True), all_names[:2])

    def test_a_bundle_not_yet_in_s3_is_never_deleted_while_shipping_is_on(self):
        all_names = names(10, 11, 12, 13, 14, 15, 16, 17, 18)
        shipped = set(all_names[1:])
        self.assertEqual(bp.to_prune(all_names, shipped, shipping_configured=True), all_names[1:2])

    def test_without_shipping_the_disk_still_keeps_only_the_newest(self):
        all_names = names(10, 11, 12, 13, 14, 15, 16, 17, 18)
        self.assertEqual(bp.to_prune(all_names, set(), shipping_configured=False), all_names[:2])

    def test_the_ledger_round_trips_and_names_what_is_left_to_ship(self):
        all_names = names(10, 11)
        ledger = bp.ledger_line(all_names[0], "ab" * 32, WHEN)
        self.assertEqual(bp.parse_ledger(ledger + "\n\n"), {all_names[0]})
        self.assertEqual(bp.unshipped(all_names, {all_names[0]}), [all_names[1]])


class Contents(unittest.TestCase):
    def test_volumes_dumped_through_their_service_are_not_also_copied_as_files(self):
        config = {"volumes": {k: {"name": "devtxnet_" + k} for k in (
            "postgres_data", "redis_vol_internal", "rabbitmq_data", "object_storage", "locales_runtime", "pg_socket")}}
        self.assertEqual(bp.file_volumes(config), {
            "object_storage": "devtxnet_object_storage", "locales_runtime": "devtxnet_locales_runtime"})

    def test_the_bundle_carries_every_key_but_its_own_passphrase(self):
        self.assertIn("dev-docker/secrets/vault-kek", bp.KEY_FILES)
        self.assertNotIn(bp.PASSPHRASE_FILE, bp.KEY_FILES)
        # a server move carries it, so the new server keeps making bundles
        self.assertIn(bp.PASSPHRASE_FILE, mp.CARRIED_FILES)

    def test_a_file_whose_checksum_changed_is_named(self):
        manifest = {"postgres/devtxnet.dump": "aa", "redis/dump.rdb": "bb"}
        problems = bp.verify_files(manifest, {"postgres/devtxnet.dump": "aa", "redis/dump.rdb": "cc"})
        self.assertEqual(len(problems), 1)
        self.assertIn("redis/dump.rdb", problems[0])

    def test_a_file_missing_from_the_bundle_is_named(self):
        self.assertEqual(len(bp.verify_files({"redis/dump.rdb": "bb"}, {})), 1)


class ShipSettings(unittest.TestCase):
    def test_env_lines_with_comments_and_quotes(self):
        text = "# S3\nBACKUP_S3_BUCKET=txnet-backups\nDOCKER_REGISTRY=docker.arvancloud.ir    # mirror\n" \
               "BACKUP_S3_PREFIX='nightly/'\n\nBROKEN LINE\n"
        self.assertEqual(bp.parse_env(text), {
            "BACKUP_S3_BUCKET": "txnet-backups", "DOCKER_REGISTRY": "docker.arvancloud.ir", "BACKUP_S3_PREFIX": "nightly/"})

    def test_the_destination_joins_bucket_prefix_and_name(self):
        self.assertEqual(bp.s3_destination({"BACKUP_S3_BUCKET": "b", "BACKUP_S3_PREFIX": "/nightly/"}, "x.gpg"),
                         "s3:b/nightly/x.gpg")
        self.assertEqual(bp.s3_destination({"BACKUP_S3_BUCKET": "b"}, "x.gpg"), "s3:b/x.gpg")

    def test_rclone_gets_its_own_names_and_nothing_extra(self):
        env = bp.rclone_env({"BACKUP_S3_ENDPOINT": "https://s3.example", "BACKUP_S3_BUCKET": "b",
                             "BACKUP_S3_ACCESS_KEY_ID": "k", "BACKUP_S3_SECRET_ACCESS_KEY": "s", "OTHER": "x"})
        self.assertEqual(env["RCLONE_CONFIG_S3_ENDPOINT"], "https://s3.example")
        self.assertEqual(env["RCLONE_CONFIG_S3_PROVIDER"], "Other")
        # a write-only key may not create or even look at the bucket
        self.assertEqual(env["RCLONE_S3_NO_CHECK_BUCKET"], "true")
        self.assertNotIn("OTHER", env)

    def test_a_missing_setting_is_named(self):
        self.assertEqual(bp.missing_ship_settings({"BACKUP_S3_BUCKET": "b"}),
                         ["BACKUP_S3_ACCESS_KEY_ID", "BACKUP_S3_ENDPOINT", "BACKUP_S3_SECRET_ACCESS_KEY"])


class HasData(unittest.TestCase):
    """Postgres 18 keeps its cluster in <volume>/18/docker, not at the volume's root."""

    def setUp(self):
        import tempfile, shutil
        self.volume = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.volume)

    def test_an_empty_volume_holds_no_data(self):
        self.assertFalse(bp.holds_data(self.volume))

    def test_a_cluster_below_the_root_is_data(self):
        os.makedirs(os.path.join(self.volume, "18", "docker"))
        open(os.path.join(self.volume, "18", "docker", "PG_VERSION"), "w").close()
        self.assertTrue(bp.holds_data(self.volume))

    def test_anything_at_all_in_the_volume_counts(self):
        # a restore that replaces an unknown layout without --replace is the failure this guards
        open(os.path.join(self.volume, "something"), "w").close()
        self.assertTrue(bp.holds_data(self.volume))

    def test_a_volume_that_does_not_exist_holds_no_data(self):
        self.assertFalse(bp.holds_data(os.path.join(self.volume, "missing")))


class Restore(unittest.TestCase):
    def test_keys_missing_here_are_restored_and_different_ones_are_kept_and_reported(self):
        in_bundle = {".env": "1", "dev-docker/secrets/vault-kek": "2", ".env.prod": "3"}
        here = {".env": "1", "dev-docker/secrets/vault-kek": "9", ".env.prod": None}
        restore, differ = bp.keys_to_restore(in_bundle, here)
        self.assertEqual(restore, [".env.prod"])
        self.assertEqual(differ, ["dev-docker/secrets/vault-kek"])

    def test_code_older_than_the_backup_is_refused(self):
        # the dump's schema has migrations this code does not know
        self.assertEqual(bp.code_relation("b", "a", is_ancestor=lambda x, y: (x, y) == ("a", "b")), bp.CODE_OLDER)

    def test_newer_code_is_allowed_and_the_same_commit_is_plain(self):
        self.assertEqual(bp.code_relation("a", "a", is_ancestor=lambda x, y: True), bp.CODE_SAME)
        self.assertEqual(bp.code_relation("a", "b", is_ancestor=lambda x, y: (x, y) == ("a", "b")), bp.CODE_NEWER)
        self.assertEqual(bp.code_relation("a", "b", is_ancestor=lambda x, y: False), bp.CODE_UNRELATED)

    def test_keys_that_expired_since_the_backup_was_made_are_not_a_loss(self):
        # a restore can come days later: every 60s captcha key is gone, 30-day sessions may be too
        source = {"redis:persistent": 80, "redis:volatile": 8000}
        self.assertEqual(mf.compare(source, {"redis:persistent": 80, "redis:volatile": 0}, mf.RESTORE_RULES), [])
        self.assertEqual(len(mf.compare(source, {"redis:persistent": 79, "redis:volatile": 0}, mf.RESTORE_RULES)), 1)

    def test_a_move_still_reads_all_expiring_keys_gone_as_a_flush(self):
        self.assertEqual(len(mf.compare({"redis:volatile": 8000}, {"redis:volatile": 0})), 1)

    def test_a_scrub_that_refuses_the_copy_stops_the_restore_before_the_services(self):
        # ADR-0168: staging's copy of production never starts with a real panel in it
        import bundle_restore as br
        sees_work = "import os, sys; sys.exit(os.environ['%s'] != '/w')" % br.RESTORE_WORK
        br.run_scrub([sys.executable, "-c", sees_work], "/w", say=lambda *a: None)
        with self.assertRaisesRegex(br.Abort, "stays stopped"):
            br.run_scrub([sys.executable, "-c", "raise SystemExit(1)"], "/w", say=lambda *a: None)


if __name__ == "__main__":
    unittest.main()
