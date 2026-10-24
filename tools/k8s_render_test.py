#!/usr/bin/env python3
"""Spec for tools/k8srender (OPS-1-o-a, hosting contract.kubernetes.md K2-K7).

Each test feeds a small compose model — the shape `docker compose config
--format json` prints — and checks one rule of the contract.

    python3 tools/k8s_render_test.py
"""
import base64
import copy
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from k8srender import RenderError, render  # noqa: E402

OPTIONS = {"registry": "registry.example", "tag": "t1"}


def model(repo: Path) -> dict:
    """A miniature production stack: a data store, the backup sidecar, an API."""
    return {
        "services": {
            "main-db": {
                "build": {"context": str(repo / "dev-docker/postgres")},
                "image": "txnet/postgres:18",
                "command": ["postgres", "-c", "archive_command=test $(date)"],
                "expose": ["5432"],
                "shm_size": 268435456,
                "stop_grace_period": "1m0s",
                "healthcheck": {"test": ["CMD-SHELL", "pg_isready -U admin"], "interval": "10s",
                                "timeout": "5s", "retries": 5, "start_period": "10s"},
                "environment": {"POSTGRES_PASSWORD": "p$(x)"},
                "volumes": [
                    {"type": "volume", "source": "postgres_data", "target": "/var/lib/postgresql"},
                    {"type": "volume", "source": "pg_socket", "target": "/var/run/postgresql"},
                    {"type": "bind", "source": "/var/backups/txnet/pg", "target": "/repo"},
                ],
                "restart": "unless-stopped",
            },
            "pg-backup": {
                "image": "txnet/postgres:18",
                "environment": {"PGBACKREST_STANZA": "txnet"},
                "volumes": [
                    {"type": "volume", "source": "pg_socket", "target": "/var/run/postgresql"},
                    {"type": "bind", "source": str(repo / "dev-docker/secrets/pg-backup-passphrase"),
                     "target": "/run/secrets/pg-backup-passphrase", "read_only": True},
                ],
            },
            "billing-service": {
                "build": {"context": str(repo / "txnet-backend")},
                "expose": ["3000"],
                "mem_limit": "536870912",
                "environment": {
                    "PORT": "3000",
                    "DATABASE_URL": "postgresql://u:p@main-db:5432/db",
                    "UNSET": None,
                },
                "labels": {"txnet.logging": "true", "traefik.enable": "true"},
                "healthcheck": {"test": ["CMD", "node", "-e", "1"], "interval": "10s", "timeout": "3s",
                                "retries": 3, "start_period": "60s"},
                "volumes": [
                    {"type": "bind", "source": str(repo / "txnet-backend"), "target": "/app"},
                    {"type": "volume", "target": "/app/node_modules"},
                    {"type": "volume", "source": "locale_cache", "target": "/var/cache/txnet-locale"},
                ],
                "depends_on": {"main-db": {"condition": "service_healthy"}},
            },
        },
        "volumes": {"postgres_data": {}, "pg_socket": {}, "locale_cache": {}},
    }


def by_kind(objects: list, kind: str, name: str) -> dict:
    return next(o for o in objects if o["kind"] == kind and o["metadata"]["name"].startswith(name))


class RenderTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        secrets = self.repo / "dev-docker/secrets"
        secrets.mkdir(parents=True)
        (secrets / "pg-backup-passphrase").write_text("s3cret\n")
        self.model = model(self.repo)

    def tearDown(self):
        self.tmp.cleanup()

    def run_render(self, m=None):
        files = render(m or self.model, self.repo, OPTIONS)
        return files, [o for objs in files.values() if isinstance(objs, list) for o in objs]

    # K3: a data store is a StatefulSet; an app rolls start-first.
    def test_workload_kinds_and_rollout(self):
        _, objs = self.run_render()
        db = by_kind(objs, "StatefulSet", "main-db")
        api = by_kind(objs, "Deployment", "billing-service")
        self.assertEqual(api["spec"]["strategy"]["rollingUpdate"], {"maxSurge": 1, "maxUnavailable": 0})
        self.assertEqual(api["spec"]["replicas"], 1)
        self.assertEqual(db["spec"]["template"]["spec"]["terminationGracePeriodSeconds"], 60)
        self.assertNotIn("depends_on", str(api))

    # K3: pg-backup is a second container in the main-db pod, socket on emptyDir.
    def test_backup_is_a_sidecar_on_a_shared_socket(self):
        _, objs = self.run_render()
        self.assertFalse([o for o in objs if o["metadata"]["name"].startswith("pg-backup")
                          and o["kind"] in ("Deployment", "StatefulSet")])
        pod = by_kind(objs, "StatefulSet", "main-db")["spec"]["template"]["spec"]
        self.assertEqual([c["name"] for c in pod["containers"]], ["main-db", "pg-backup"])
        socket = next(v for v in pod["volumes"] if v["name"] == "pg-socket")
        self.assertEqual(socket, {"name": "pg-socket", "emptyDir": {}})
        self.assertEqual(pod["containers"][1]["image"], pod["containers"][0]["image"])

    # K4: a ClusterIP Service per exposed port; a call to an unexposed host fails.
    def test_services_from_expose_and_calls_checked(self):
        _, objs = self.run_render()
        svc = by_kind(objs, "Service", "billing-service")
        self.assertEqual([p["port"] for p in svc["spec"]["ports"]], [3000])
        broken = copy.deepcopy(self.model)
        broken["services"]["billing-service"]["environment"]["DATABASE_URL"] = "postgresql://main-db:6000/db"
        with self.assertRaisesRegex(RenderError, "billing-service.*main-db:6000"):
            self.run_render(broken)

    # K5: the environment is one Secret per service; command `$(` is escaped.
    def test_environment_secret_and_escaping(self):
        _, objs = self.run_render()
        container = by_kind(objs, "Deployment", "billing-service")["spec"]["template"]["spec"]["containers"][0]
        ref = container["envFrom"][0]["secretRef"]["name"]
        secret = by_kind(objs, "Secret", ref)
        self.assertEqual(secret["metadata"]["name"], ref)
        data = {k: base64.b64decode(v).decode() for k, v in secret["data"].items()}
        self.assertEqual(data, {"PORT": "3000", "DATABASE_URL": "postgresql://u:p@main-db:5432/db"})
        self.assertNotIn("env", container)
        db = by_kind(objs, "StatefulSet", "main-db")["spec"]["template"]["spec"]["containers"][0]
        self.assertEqual(db["args"][-1], "archive_command=test $$(date)")

    # K5: a changed value changes the Secret's name, so the pod rolls.
    def test_changed_value_renames_the_secret(self):
        _, before = self.run_render()
        changed = copy.deepcopy(self.model)
        changed["services"]["billing-service"]["environment"]["PORT"] = "3001"
        _, after = self.run_render(changed)
        names = lambda objs: {o["metadata"]["name"] for o in objs if o["kind"] == "Secret"}
        self.assertNotEqual(names(before), names(after))

    # K6: healthcheck -> readiness, liveness and a startup probe for the start period.
    def test_probes_from_healthcheck(self):
        _, objs = self.run_render()
        c = by_kind(objs, "Deployment", "billing-service")["spec"]["template"]["spec"]["containers"][0]
        self.assertEqual(c["readinessProbe"]["exec"]["command"], ["node", "-e", "1"])
        self.assertEqual(c["readinessProbe"]["periodSeconds"], 10)
        self.assertEqual(c["livenessProbe"]["failureThreshold"], 3)
        self.assertEqual(c["startupProbe"]["failureThreshold"], 6)
        db = by_kind(objs, "StatefulSet", "main-db")["spec"]["template"]["spec"]["containers"][0]
        self.assertEqual(db["readinessProbe"]["exec"]["command"], ["sh", "-c", "pg_isready -U admin"])

    # K7: named volume -> claim, host dir -> hostPath, secret file -> Secret,
    # source tree and the node_modules shadow under it -> dropped.
    def test_volumes(self):
        _, objs = self.run_render()
        pod = by_kind(objs, "StatefulSet", "main-db")["spec"]["template"]["spec"]
        vols = {v["name"]: v for v in pod["volumes"]}
        self.assertEqual(vols["postgres-data"]["persistentVolumeClaim"]["claimName"], "postgres-data")
        self.assertEqual(vols["host-var-backups-txnet-pg"]["hostPath"],
                         {"path": "/var/backups/txnet/pg", "type": "DirectoryOrCreate"})
        self.assertEqual(vols["dshm"]["emptyDir"]["medium"], "Memory")
        mount = next(m for m in pod["containers"][1]["volumeMounts"]
                     if m["mountPath"] == "/run/secrets/pg-backup-passphrase")
        self.assertEqual((mount["subPath"], mount["readOnly"]), ("pg-backup-passphrase", True))
        api = by_kind(objs, "Deployment", "billing-service")["spec"]["template"]["spec"]
        self.assertEqual([m["mountPath"] for m in api["containers"][0]["volumeMounts"]],
                         ["/var/cache/txnet-locale"])
        claims = {o["metadata"]["name"] for o in objs if o["kind"] == "PersistentVolumeClaim"}
        self.assertEqual(claims, {"postgres-data", "locale-cache"})

    def test_unknown_bind_directory_fails(self):
        broken = copy.deepcopy(self.model)
        (self.repo / "somewhere").mkdir()
        broken["services"]["billing-service"]["volumes"].append(
            {"type": "bind", "source": str(self.repo / "somewhere"), "target": "/x"})
        with self.assertRaisesRegex(RenderError, "billing-service.*somewhere"):
            self.run_render(broken)

    # K2: a compose key the renderer does not map is an error, never a drop.
    def test_unknown_key_fails(self):
        broken = copy.deepcopy(self.model)
        broken["services"]["billing-service"]["privileged"] = True
        with self.assertRaisesRegex(RenderError, "billing-service.*privileged"):
            self.run_render(broken)

    # K3: Docker's host-gateway is the node, whose address the deploy passes.
    def test_host_gateway_is_the_node(self):
        m = copy.deepcopy(self.model)
        m["services"]["billing-service"]["extra_hosts"] = ["host.docker.internal=host-gateway"]
        with self.assertRaisesRegex(RenderError, "billing-service.*--host-gateway"):
            self.run_render(m)
        files = render(m, self.repo, {**OPTIONS, "host_gateway": "10.0.0.5"})
        api = by_kind(files["billing-service.yaml"], "Deployment", "billing-service")
        self.assertEqual(api["spec"]["template"]["spec"]["hostAliases"],
                         [{"ip": "10.0.0.5", "hostnames": ["host.docker.internal"]}])

    # K3/K11: images are named for the registry; the logging label reaches the pod.
    def test_images_and_labels(self):
        files, objs = self.run_render()
        tpl = by_kind(objs, "Deployment", "billing-service")["spec"]["template"]
        self.assertEqual(tpl["spec"]["containers"][0]["image"], "registry.example/txnet/billing-service:t1")
        self.assertEqual(tpl["metadata"]["labels"]["txnet.io/logging"], "true")
        self.assertEqual(tpl["spec"]["containers"][0]["resources"]["limits"]["memory"], "536870912")
        self.assertIn("kustomization.yaml", files)


REPO = Path(__file__).resolve().parent.parent


# K4 at HEAD (OPS-1-o-h): the miniature above cannot see a call one real service
# makes to another, so the repo's own production model is rendered too. It needs
# docker's compose CLI and the env files; without them it is skipped, not passed.
@unittest.skipUnless(shutil.which("docker") and (REPO / ".env").exists() and (REPO / ".env.prod").exists(),
                     "needs docker compose and the repo's .env / .env.prod")
class RepoModelTest(unittest.TestCase):
    def test_the_production_model_renders(self):
        with tempfile.TemporaryDirectory() as out:
            result = subprocess.run([sys.executable, str(REPO / "tools/k8s_render.py"), f"{out}/base",
                                     "--host-gateway", "10.0.0.5", "--tag", "t1"],
                                    capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
