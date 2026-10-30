#!/usr/bin/env python3
"""Spec for a release's reach (OPS-1-ah-l, ADR-0169; hosting contract.release-reach.md).

    python3 tools/release_reach_test.py
"""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import release_reach as rr  # noqa: E402

REG = "registry.example:5000/txnet"


def workload(name: str, tag: str, env: str = "a") -> str:
    """One rendered Deployment, as k8s_render writes it."""
    return (f"apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: {name}\nspec:\n  template:\n"
            f"    spec:\n      containers:\n      - name: {name}\n        image: {REG}/{name}:{tag}\n"
            f"        env:\n        - name: MODE\n          value: {env}\n")


def render(**tags) -> dict[str, str]:
    return {f"{name.replace('_', '-')}.yaml": workload(name.replace('_', '-'), tag) for name, tag in tags.items()}


DECLARED = {"site-pwa": {"lane": "quick"}, "coinsite": {"lane": "quick"},
            "network-service": {"checks": ["panels"]}, "main-db": {"checks": ["stores"]}}


class CompareTest(unittest.TestCase):
    def test_a_tag_is_read_after_a_registry_port(self):
        self.assertEqual(rr.images_of({"a.yaml": workload("site-pwa", "abc")}), {"site-pwa": f"{REG}/site-pwa:abc"})

    def test_only_the_images_whose_tag_moved(self):
        reach = rr.compare(render(site_pwa="1", billing_service="1"), render(site_pwa="2", billing_service="1"))
        self.assertEqual(reach, rr.Reach(images=frozenset({"site-pwa"}), manifests=()))

    def test_anything_but_a_tag_is_a_manifest_change(self):
        old = render(site_pwa="1")
        new = {"site-pwa.yaml": workload("site-pwa", "2", env="b")}
        self.assertEqual(rr.compare(old, new).manifests, ("site-pwa.yaml",))

    def test_a_file_added_or_removed_is_a_manifest_change(self):
        reach = rr.compare(render(site_pwa="1"), render(site_pwa="1", sub_service="1"))
        self.assertEqual(reach.manifests, ("sub-service.yaml",))


class LaneTest(unittest.TestCase):
    def test_a_frontend_alone_skips_the_twin(self):
        reach = rr.Reach(images=frozenset({"site-pwa", "coinsite"}), manifests=())
        self.assertEqual(rr.lane(reach, DECLARED), rr.QUICK)
        self.assertEqual(rr.checks(reach, DECLARED), ("ready",))

    def test_nothing_to_roll_skips_the_twin(self):
        self.assertEqual(rr.lane(rr.Reach(frozenset(), ()), DECLARED), rr.QUICK)

    def test_one_undeclared_service_takes_the_twin(self):
        # db-migrate declares nothing: a migration or a seed always meets production's data.
        reach = rr.Reach(images=frozenset({"site-pwa", "db-migrate"}), manifests=())
        self.assertEqual(rr.lane(reach, DECLARED), rr.TWIN)
        self.assertEqual(rr.checks(reach, DECLARED), ("ready",))

    def test_a_service_brings_the_checks_it_declares(self):
        reach = rr.Reach(images=frozenset({"network-service", "main-db"}), manifests=())
        self.assertEqual(rr.lane(reach, DECLARED), rr.TWIN)
        self.assertEqual(rr.checks(reach, DECLARED), ("ready", "panels", "stores"))

    def test_a_manifest_change_takes_every_check_even_beside_a_frontend(self):
        reach = rr.Reach(images=frozenset({"site-pwa"}), manifests=("edge.yaml",))
        self.assertEqual(rr.lane(reach, DECLARED), rr.TWIN)
        self.assertEqual(rr.checks(reach, DECLARED), rr.TWIN_CHECKS)


class DeclaredTest(unittest.TestCase):
    def test_read_from_the_compose_model(self):
        services = {"site-pwa": {"x-release": {"lane": "quick"}}, "billing-service": {"image": "x"}}
        self.assertEqual(rr.declared_of(services), {"site-pwa": {"lane": "quick"}})

    def test_a_misspelt_declaration_is_refused_not_ignored(self):
        for bad in ({"lane": "fast"}, {"checks": ["panel"]}, {"lanes": "quick"}, {"checks": "panels"}):
            with self.subTest(bad=bad), self.assertRaises(rr.ReachError):
                rr.declared_of({"site-pwa": {"x-release": bad}})


if __name__ == "__main__":
    unittest.main()
