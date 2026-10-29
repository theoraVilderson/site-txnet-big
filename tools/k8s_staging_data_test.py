#!/usr/bin/env python3
"""Spec for production's data in the staging cluster (OPS-1-ah-b, ADR-0166 point 3).

    python3 tools/k8s_staging_data_test.py
"""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).parent))
import k8s_staging_data as kd  # noqa: E402


class SourceTest(unittest.TestCase):
    def test_the_newest_of_productions_bundles(self):
        names = ["txnet-backup-txnet-2026-10-24_22-17-13Z.tar.zst.gpg",
                 "txnet-backup-txnet-2026-10-29_08-51-59Z.tar.zst.gpg",
                 "txnet-backup-txnet-2026-10-29_08-51-59Z.tar.zst.gpg.sha256",
                 # dev's bundle on the same server is never production's data
                 "txnet-backup-devtxnet-2026-10-30_03-00-39Z.tar.zst.gpg"]
        self.assertEqual(kd.newest_bundle(names), "txnet-backup-txnet-2026-10-29_08-51-59Z.tar.zst.gpg")

    def test_no_bundle_is_said(self):
        with self.assertRaisesRegex(kd.StagingError, "no bundle"):
            kd.newest_bundle(["txnet-backup-devtxnet-2026-10-30_03-00-39Z.tar.zst.gpg"])

    def test_the_server_comes_from_the_environment_and_a_gap_is_named(self):
        env = {kd.HOST_VAR: "root@prod.example", kd.KEY_VAR: "/k"}
        self.assertEqual(kd.Production.from_env(env).ssh("ls"),
                         ["ssh", "-i", "/k", "-o", "BatchMode=yes", "root@prod.example", "ls"])
        with self.assertRaisesRegex(kd.StagingError, kd.KEY_VAR):
            kd.Production.from_env({kd.HOST_VAR: "root@prod.example"})


class AgeKeyTest(unittest.TestCase):
    """The key that opens production's sealed secrets stays in memory: the place
    sops and the restore read is a link into the memory directory."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.key, self.place = base / "shm" / "age.key", base / "etc" / "age.key"
        self.key.parent.mkdir()
        self.key.write_text("AGE-SECRET-KEY-1")

    def tearDown(self):
        self.tmp.cleanup()

    def test_linked_and_unlinked(self):
        kd.link_age_key(self.key, self.place)
        self.assertEqual(os.readlink(self.place), str(self.key))
        kd.unlink_age_key(self.key.parent, self.place)
        self.assertFalse(self.place.exists() or self.place.is_symlink())

    def test_a_real_key_here_is_never_replaced_or_removed(self):
        self.place.parent.mkdir()
        self.place.write_text("this host's own")
        with self.assertRaisesRegex(kd.StagingError, "already"):
            kd.link_age_key(self.key, self.place)
        kd.unlink_age_key(self.key.parent, self.place)
        self.assertEqual(self.place.read_text(), "this host's own")


class ImagesTest(unittest.TestCase):
    def test_every_image_the_render_names_once(self):
        with tempfile.TemporaryDirectory() as d:
            (Path(d) / "a.yaml").write_text("    image: reg/a:1\n    image: mirror/redis:8\n")
            (Path(d) / "b.yaml").write_text("      image: reg/a:1\n")
            self.assertEqual(kd.rendered_images([Path(d)]), ["mirror/redis:8", "reg/a:1"])


class AtTest(unittest.TestCase):
    # Production's own commit cannot start offline until OPS-1-ai reaches it; a
    # newer commit is restored into, as B9 allows only when asked.
    def test_a_newer_commit_is_asked_for_by_name(self):
        argv, _ = kd.restore_command(Path("/t"), Path("/b"), Path("/p"), Path("/m"), "h", newer_code=True)
        self.assertEqual(argv[-1], "--allow-newer-code")
        argv, _ = kd.restore_command(Path("/t"), Path("/b"), Path("/p"), Path("/m"), "h")
        self.assertNotIn("--allow-newer-code", argv)


class RestoreTest(unittest.TestCase):
    def test_restore_replaces_staging_and_keeps_its_safety_bundle_in_memory(self):
        argv, env = kd.restore_command(Path("/shm/tree"), Path("/shm/b.gpg"), Path("/shm/p"), Path("/shm"), "2.144.31.149")
        self.assertEqual(argv[:9], ["python3", f"{kd.ROOT}/scripts/bundle/backup.py", "restore", "/shm/b.gpg",
                                    "--stack", "k8s", "--passphrase-file", "/shm/p", "--replace"])
        self.assertEqual(env["BACKUP_BUNDLE_DIR"], "/shm/safety")

    # ADR-0168 point 1: the copy is scrubbed before any service of staging starts.
    # This checkout's restore runs it: production's tree may predate --scrub.
    def test_the_restore_scrubs_the_tree_it_restores_into_before_the_services(self):
        argv, _ = kd.restore_command(Path("/shm/tree"), Path("/shm/b.gpg"), Path("/shm/p"), Path("/shm"), "2.144.31.149")
        self.assertEqual(argv[argv.index("--checkout") + 1], "/shm/tree")
        scrub = argv[argv.index("--scrub") + 1]
        self.assertIn(f"{kd.ROOT}/tools/k8s_staging_scrub.py scrub --prod-host 2.144.31.149", scrub)


class WorktreeTest(unittest.TestCase):
    # 2026-10-29: a tree left at 7e49eb78 by an earlier run was deployed under a
    # bundle of 4b8a0cfa, and B9 refused the restore. A tree is the commit asked.
    def test_a_tree_left_at_another_commit_is_moved_to_the_one_asked(self):
        def git(*argv):
            return subprocess.run(["git", "-C", repo, *argv], check=True, capture_output=True, text=True).stdout.strip()
        with tempfile.TemporaryDirectory() as repo, tempfile.TemporaryDirectory() as shm:
            git("init", "-q")
            commits = []
            for n in ("one", "two"):
                git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", n)
                commits.append(git("rev-parse", "HEAD"))
            with mock.patch.object(kd, "ROOT", Path(repo)), mock.patch.object(kd, "SHM_DIR", Path(shm)):
                kd.worktree(commits[0])
                tree = kd.worktree(commits[1])
            self.assertEqual(subprocess.run(["git", "-C", str(tree), "rev-parse", "HEAD"], capture_output=True,
                                            text=True).stdout.strip(), commits[1])


if __name__ == "__main__":
    unittest.main()
