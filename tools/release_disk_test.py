#!/usr/bin/env python3
"""Spec for the release's disk step (hosting R16, tools/release_disk.py).

    python3 tools/release_disk_test.py
"""
import subprocess
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import release_disk as rd  # noqa: E402

REG = "registry.example/txnet"
CURRENT = [f"{REG}/api:new", f"{REG}/web:same"]


class StaleImagesTest(unittest.TestCase):
    # 2026-10-31: 12 GB of earlier releases' images on the build host, each still
    # tagged, so `docker image prune` never saw them.
    def test_an_earlier_release_of_the_same_repository_is_stale(self):
        local = [f"{REG}/api:new", f"{REG}/api:old", f"{REG}/web:same", f"{REG}/web:older"]
        self.assertEqual(rd.stale_images(CURRENT, local), [f"{REG}/api:old", f"{REG}/web:older"])

    def test_images_outside_the_release_are_never_touched(self):
        local = ["devtxnet-locale-service:latest", "txnet/postgres:18", "node:24", f"{REG}/api:<none>",
                 "registry.example/other/api:old"]
        self.assertEqual(rd.stale_images(CURRENT, local), [])

    def test_a_registry_with_a_port_is_one_repository(self):
        current = ["reg:5000/txnet/api:new"]
        self.assertEqual(rd.stale_images(current, ["reg:5000/txnet/api:old"]), ["reg:5000/txnet/api:old"])


class FreeDiskTest(unittest.TestCase):
    def run_free_disk(self):
        calls = []

        def run(argv, **_):
            calls.append(argv)
            out = ""
            if "--images" in argv:
                out = "".join(f"svc\tlocal\t{ref}\n" for ref in CURRENT)
            elif argv[:3] == ["docker", "image", "ls"]:
                out = f"{REG}/api:new\n{REG}/api:old\nnode:24\n"
            return subprocess.CompletedProcess(argv, 0, out, "")
        problem = rd.free_disk(run=run, room=lambda: None)
        return problem, calls

    def test_the_stale_tag_is_removed_without_force(self):
        _, calls = self.run_free_disk()
        self.assertIn(["docker", "rmi", f"{REG}/api:old"], calls)
        self.assertFalse([c for c in calls if c[:2] == ["docker", "rmi"] and "-f" in c])
        self.assertFalse([c for c in calls if f"{REG}/api:new" in c or "node:24" in c])

    # The old step pruned `docker builder`, the engine's own builder; compose
    # builds with buildx's current one, which grew to 11 GB untouched.
    def test_the_build_cache_of_compose_s_builder_is_capped(self):
        _, calls = self.run_free_disk()
        self.assertIn(["docker", "buildx", "prune", "-f", "--keep-storage", rd.BUILD_CACHE_KEEP], calls)

    def test_volumes_are_never_pruned(self):
        _, calls = self.run_free_disk()
        self.assertFalse([c for c in calls if "volume" in c])


if __name__ == "__main__":
    unittest.main()
