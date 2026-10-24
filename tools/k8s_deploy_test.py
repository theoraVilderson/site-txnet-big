#!/usr/bin/env python3
"""Spec for images and deploy (OPS-1-o-c, hosting contract.kubernetes.md K8, K10).

    python3 tools/k8s_deploy_test.py
"""
import base64
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).parent))
from k8s_manifest import stores, workloads  # noqa: E402
from k8srender import render  # noqa: E402
from k8srender.container import built_images  # noqa: E402
from k8srender.tables import BAKED_BINDS, NAMESPACE  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
OPTIONS = {"registry": "registry.example", "tag": "t1"}


def model(repo: Path) -> dict:
    return {"services": {
        "main-db": {"build": {"context": "x"}, "image": "txnet/postgres:18", "expose": ["5432"]},
        "pg-backup": {"image": "txnet/postgres:18"},
        "billing-service": {"build": {"context": "x", "target": "prod"}},
        "locale-service": {"build": {"context": "x"},
                           "volumes": [{"type": "bind", "source": str(repo / "locales"), "target": "/locales"}]},
        "db-migrate": {
            "build": {"context": "x", "target": "dependencies"},
            "profiles": ["migrate"],
            "restart": "no",
            "command": ["npx", "prisma", "migrate", "deploy", "--schema", "prisma/domains"],
            "environment": {"DATABASE_URL": "postgresql://admin:p@main-db:5432/db"},
        },
        "redis": {"image": "redis:8"},
    }}


class JobTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        self.files = render(model(self.repo), self.repo, OPTIONS)

    def tearDown(self):
        self.tmp.cleanup()

    # K8: a service that runs once is a Job that runs once, outside the base,
    # so `deploy` can run it to completion before applying the base.
    def test_runs_once_is_a_job_beside_the_base(self):
        job, secret = self.files["jobs/db-migrate.yaml"]
        self.assertEqual((job["kind"], job["apiVersion"]), ("Job", "batch/v1"))
        self.assertEqual(job["spec"]["backoffLimit"], 0)
        pod = job["spec"]["template"]["spec"]
        self.assertEqual(pod["restartPolicy"], "Never")
        self.assertEqual(pod["containers"][0]["image"], "registry.example/txnet/db-migrate:t1")
        self.assertEqual(pod["containers"][0]["args"][-3:], ["deploy", "--schema", "prisma/domains"])
        self.assertEqual(base64.b64decode(secret["data"]["DATABASE_URL"]).decode(),
                         "postgresql://admin:p@main-db:5432/db")
        self.assertNotIn("jobs/db-migrate.yaml", self.files["kustomization.yaml"]["resources"])
        self.assertNotIn("db-migrate.yaml", self.files)
        jobs = self.files["jobs/kustomization.yaml"]
        self.assertEqual((jobs["namespace"], jobs["resources"]), (NAMESPACE, ["db-migrate.yaml"]))

    # K8: locales/ is in locale-service's image (36 MB, past a ConfigMap's 1 MiB).
    def test_locales_are_not_mounted(self):
        pod = self.files["locale-service.yaml"][0]["spec"]["template"]["spec"]
        self.assertNotIn("volumeMounts", pod["containers"][0])


# K8: every image compose builds, its local name and the name the node pulls;
# pg-backup runs main-db's image and is not built twice.
class ImagesTest(unittest.TestCase):
    def test_built_images(self):
        images = built_images(model(Path("/r"))["services"], "txnet", OPTIONS)
        self.assertEqual(images, [
            ("billing-service", "txnet-billing-service", "registry.example/txnet/billing-service:t1"),
            ("db-migrate", "txnet-db-migrate", "registry.example/txnet/db-migrate:t1"),
            ("locale-service", "txnet-locale-service", "registry.example/txnet/locale-service:t1"),
            ("main-db", "txnet/postgres:18", "registry.example/txnet/main-db:t1"),
        ])


MANIFEST = """
apiVersion: v1
kind: Secret
metadata: {name: s}
---
apiVersion: apps/v1
kind: StatefulSet
metadata: {name: main-db, namespace: txnet}
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: billing-service, namespace: txnet}
"""


# K10: `deploy` applies what the Deployments need first, then waits on each workload.
class ManifestTest(unittest.TestCase):
    def test_stores_leave_out_deployments(self):
        self.assertEqual([o["kind"] for o in yaml.safe_load_all(stores(MANIFEST))], ["Secret", "StatefulSet"])

    def test_workloads(self):
        self.assertEqual(workloads(MANIFEST), ["statefulset/main-db", "deployment/billing-service"])


# K8: what the renderer leaves unmounted is copied in by the Dockerfile named for it.
class BakedTest(unittest.TestCase):
    def test_every_baked_directory_is_copied(self):
        for rel, dockerfile in BAKED_BINDS.items():
            name = re.escape(Path(rel).name)
            self.assertRegex((REPO / dockerfile).read_text(), rf"(?m)^COPY (--from={name} |{name}/ )", rel)


class ScriptTest(unittest.TestCase):
    def test_prod_k8s_parses(self):
        subprocess.run(["bash", "-n", str(REPO / "scripts/prod.k8s.sh")], check=True)

    @unittest.skipUnless(shutil.which("shellcheck"), "shellcheck not installed")
    def test_prod_k8s_is_clean(self):
        subprocess.run(["shellcheck", str(REPO / "scripts/prod.k8s.sh")], check=True)


if __name__ == "__main__":
    unittest.main()
