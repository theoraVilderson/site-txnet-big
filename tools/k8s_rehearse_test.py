#!/usr/bin/env python3
"""Spec for the rehearsal's proof (OPS-1-o-f, hosting K12).

    python3 tools/k8s_rehearse_test.py
"""
import shutil
import subprocess
import sys
import tempfile
import unittest
from collections import Counter
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).parent))
import k8s_rehearse as kr  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
REHEARSAL = REPO / "k8s/overlays/rehearsal/kustomization.yaml"


def workload(kind, name, replicas, ready, namespace="txnet"):
    status = ({"desiredNumberScheduled": replicas, "numberReady": ready} if kind == "DaemonSet"
              else {"readyReplicas": ready} if ready else {})
    return {"kind": kind, "metadata": {"name": name, "namespace": namespace},
            "spec": {} if kind == "DaemonSet" else {"replicas": replicas}, "status": status}


def route(name, backend, match):
    return {"kind": "IngressRoute", "metadata": {"name": name, "namespace": "txnet"},
            "spec": {"entryPoints": ["websecure"], "routes": [{"match": match, "services": [{"name": backend}]}]}}


class ReadyTest(unittest.TestCase):
    def test_short_workloads_are_named(self):
        listing = {"items": [workload("Deployment", "billing-service", 1, 1),
                             workload("StatefulSet", "main-db", 1, 0),
                             workload("DaemonSet", "promtail", 1, 0, "txnet-monitoring")]}
        self.assertEqual(kr.not_ready(listing), ["txnet/statefulset/main-db 0/1",
                                                 "txnet-monitoring/daemonset/promtail 0/1"])

    def test_zero_replicas_is_ready(self):
        self.assertEqual(kr.not_ready({"items": [workload("Deployment", "translator-llm", 0, 0)]}), [])


class RollTest(unittest.TestCase):
    def test_only_routes_to_the_rolled_service(self):
        objects = [route("billing", "billing-service", "Host(`api.example`) && PathPrefix(`/api/billing`)"),
                   route("auth", "auth-service", "Host(`api.example`) && PathPrefix(`/api/auth`)")]
        requests = kr.routes_to(objects, "billing-service", "api.example")
        self.assertEqual([(r.host, r.path, r.scheme) for r in requests], [("api.example", "/api/billing", "https")])

    def test_a_5xx_or_no_answer_fails_a_4xx_does_not(self):
        self.assertEqual(kr.failed(Counter({"200": 40, "401": 9, "404": 1})), 0)
        self.assertEqual(kr.failed(Counter({"200": 40, "502": 2, "000": 1})), 3)


class BundleTest(unittest.TestCase):
    def test_the_made_bundle_is_read_from_backup_now(self):
        out = ("backup: stopping nothing\n"
               "backup: /var/backups/txnet/bundles/txnet-backup-prodtxnet-20261024_190000Z.tar.zst.gpg (12 MB, 40s)\n"
               "backup: 120 tables, 3+0 Redis keys, 1 queued messages, 2 file volumes, 9 keys and env files\n")
        self.assertEqual(kr.bundle_path(out),
                         "/var/backups/txnet/bundles/txnet-backup-prodtxnet-20261024_190000Z.tar.zst.gpg")

    def test_no_bundle_named_fails(self):
        with self.assertRaises(RuntimeError):
            kr.bundle_path("backup: nothing\n")


def apply_patch(doc, operations):
    """JSON Patch `test` and `remove` on list indices, as kustomize applies them."""
    for op in operations:
        *parents, last = [p for p in op["path"].split("/") if p]
        node = doc
        for key in parents:
            node = node[int(key)] if isinstance(node, list) else node[key]
        if op["op"] == "test":
            if node[int(last)] != op["value"]:
                raise AssertionError(f"test failed at {op['path']}: {node[int(last)]!r}")
        else:
            del node[int(last)]


# K12 at HEAD: the overlay's pinned arguments are where the renderer puts them,
# so the patch removes exactly ACME's four. A compose change that moves one fails here.
@unittest.skipUnless(shutil.which("docker") and (REPO / ".env").exists() and (REPO / ".env.prod").exists(),
                     "needs docker compose and the repo's .env / .env.prod")
class RehearsalOverlayTest(unittest.TestCase):
    def test_acme_is_removed_and_nothing_else(self):
        with tempfile.TemporaryDirectory() as out:
            subprocess.run([sys.executable, str(REPO / "tools/k8s_render.py"), out, "--tag", "t1",
                            "--host-gateway", "10.0.0.5"], check=True, capture_output=True)
            traefik = next(d for d in yaml.safe_load_all((Path(out) / "gateway-handler.yaml").read_text())
                           if d and d["kind"] == "Deployment")
        before = list(traefik["spec"]["template"]["spec"]["containers"][0]["args"])
        patch = yaml.safe_load(yaml.safe_load(REHEARSAL.read_text())["patches"][0]["patch"])
        apply_patch(traefik, patch)
        after = traefik["spec"]["template"]["spec"]["containers"][0]["args"]
        self.assertEqual(after, [a for a in before if not a.startswith("--certificatesresolvers.")])
        self.assertEqual(len(before) - len(after), 4)


if __name__ == "__main__":
    unittest.main()
