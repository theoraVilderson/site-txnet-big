#!/usr/bin/env python3
"""Spec for the registry's retention (hosting R22, OPS-1-ah-m, tools/release_registry.py).

    python3 tools/release_registry_test.py
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import k8s_release as kr  # noqa: E402
import release_registry as rg  # noqa: E402

REG = "reg.example"
HISTORY = ["c1", "c2", "c3", "c4", "c5", "c6", "c7"]


def render(images_by_commit):
    return lambda commit: images_by_commit[commit]


class FakeRegistry:
    host = REG

    def __init__(self, tags: dict[str, dict[str, str]]):
        self.repos = tags  # {repo: {tag: digest}}
        self.deleted = []

    def tags(self, repo):
        return list(self.repos.get(repo, {}))

    def digest(self, repo, tag):
        return self.repos[repo][tag]

    def delete(self, repo, digest):
        self.deleted.append((repo, digest))


def release(tag, **extra):
    return {"api": f"{REG}/txnet/api:{tag}", "postgres": "docker.example/postgres:18", **extra}


class RetentionTest(unittest.TestCase):
    def test_only_the_last_kept_releases_are_rendered(self):
        seen = []
        rg.kept_images(HISTORY, lambda c: seen.append(c) or {})
        self.assertEqual(seen, HISTORY[-kr.IMAGES_KEPT:])

    # 2026-10-31: 16 releases, every tag ever pushed, 5.4 GB.
    def test_a_tag_no_kept_release_names_is_deleted(self):
        images = {c: release(c) for c in HISTORY}
        reg = FakeRegistry({"txnet/api": {c: f"sha256:{c}" for c in HISTORY}})
        rg.prune(HISTORY, render(images), reg)
        self.assertEqual(reg.deleted, [("txnet/api", "sha256:c1"), ("txnet/api", "sha256:c2")])

    # A DELETE by digest removes every tag on it: a stale tag sharing a kept
    # tag's digest would take the kept one with it.
    def test_a_digest_a_kept_tag_shares_is_never_deleted(self):
        images = {c: release(c) for c in HISTORY}
        tags = {c: f"sha256:{c}" for c in HISTORY}
        tags["c1"] = "sha256:c7"
        reg = FakeRegistry({"txnet/api": tags})
        rg.prune(HISTORY, render(images), reg)
        self.assertEqual(reg.deleted, [("txnet/api", "sha256:c2")])

    def test_an_unchanged_service_keeps_its_one_tag(self):
        images = {c: release("same") for c in HISTORY}
        reg = FakeRegistry({"txnet/api": {"same": "sha256:s", "older": "sha256:o"}})
        rg.prune(HISTORY, render(images), reg)
        self.assertEqual(reg.deleted, [("txnet/api", "sha256:o")])

    def test_a_repository_no_kept_release_uses_is_left_alone(self):
        images = {c: release(c) for c in HISTORY}
        reg = FakeRegistry({"txnet/api": {c: f"sha256:{c}" for c in HISTORY[-5:]},
                            "txnet/push-proof": {"x": "sha256:x"}})
        rg.prune(HISTORY, render(images), reg)
        self.assertEqual(reg.deleted, [])

    # Not knowing what a kept release runs is never a reason to delete.
    def test_a_release_that_does_not_render_deletes_nothing(self):
        def broken(commit):
            if commit == "c5":
                raise RuntimeError("render failed")
            return release(commit)
        reg = FakeRegistry({"txnet/api": {c: f"sha256:{c}" for c in HISTORY}})
        with self.assertRaises(RuntimeError):
            rg.prune(HISTORY, broken, reg)
        self.assertEqual(reg.deleted, [])

    def test_no_history_deletes_nothing(self):
        reg = FakeRegistry({"txnet/api": {"a": "sha256:a"}})
        rg.prune([], render({}), reg)
        self.assertEqual(reg.deleted, [])


class RestorableTest(unittest.TestCase):
    def test_rollback_reaches_only_the_releases_whose_images_are_kept(self):
        self.assertTrue(kr.restorable(HISTORY, HISTORY[-kr.IMAGES_KEPT]))
        self.assertFalse(kr.restorable(HISTORY, HISTORY[-kr.IMAGES_KEPT - 1]))
        self.assertFalse(kr.restorable(HISTORY, "unknown"))


class PushWindowTest(unittest.TestCase):
    # The registry collects nightly at 00:30 UTC (dev-docker/registry/arvan-values.yaml);
    # a collect during a push can remove layers not yet tagged.
    def test_a_push_waits_out_the_nightly_collect(self):
        self.assertIsNotNone(kr.push_problem(0, 25))
        self.assertIsNotNone(kr.push_problem(0, 45))

    def test_a_push_outside_it_goes(self):
        self.assertIsNone(kr.push_problem(0, 15))
        self.assertIsNone(kr.push_problem(0, 55))
        self.assertIsNone(kr.push_problem(13, 30))


if __name__ == "__main__":
    unittest.main()
