#!/usr/bin/env python3
"""Spec for tools/k8srender (OPS-1-o-a, hosting contract.kubernetes.md K2-K7).

Each test feeds a small compose model — the shape `docker compose config
--format json` prints — and checks one rule of the contract.

    python3 tools/k8s_render_test.py
"""
import base64
import copy
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).parent))
from k8srender import RenderError, render  # noqa: E402
from k8srender.tables import DATA_NODE_LABEL  # noqa: E402

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
                "healthcheck": {"test": ["CMD-SHELL", "test -f /tmp/healthy"], "interval": "30s",
                                "timeout": "3s", "retries": 3, "start_period": "60s"},
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
                "mem_reservation": 167772160,
                "environment": {
                    "PORT": "3000",
                    "DATABASE_URL": "postgresql://u:p@main-db:5432/db",
                    "UNSET": None,
                },
                "labels": {"txnet.logging": "true", "traefik.enable": "true"},
                "healthcheck": {"test": ["CMD", "node", "-e", "1"], "interval": "10s", "timeout": "3s",
                                "retries": 3, "start_period": "60s"},
                "volumes": [
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

    # K6: a sidecar's failing check restarts it; it never takes the pod out of its Service.
    def test_a_sidecar_is_restarted_never_taken_out_of_service(self):
        _, objs = self.run_render()
        db, backup = by_kind(objs, "StatefulSet", "main-db")["spec"]["template"]["spec"]["containers"]
        self.assertIn("readinessProbe", db)
        self.assertNotIn("readinessProbe", backup)
        self.assertEqual(backup["livenessProbe"]["exec"]["command"], ["sh", "-c", "test -f /tmp/healthy"])
        self.assertEqual(backup["startupProbe"]["failureThreshold"], 5)

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
        self.assertEqual(c["startupProbe"]["failureThreshold"], 9)
        db = by_kind(objs, "StatefulSet", "main-db")["spec"]["template"]["spec"]["containers"][0]
        self.assertEqual(db["readinessProbe"]["exec"]["command"], ["sh", "-c", "pg_isready -U admin"])

    # K6 (LIVE-1-r, 2026-10-28): liveness never asks the database. `x-liveness`
    # is the service's own "does the process answer" check; readiness keeps the
    # healthcheck. A main-db restart otherwise had every Nest service killed for
    # an outage that was not its own, and a pod booting while it was down never
    # started at all, so the startup probe takes the liveness check too.
    def test_liveness_and_startup_take_x_liveness_readiness_keeps_the_healthcheck(self):
        changed = copy.deepcopy(self.model)
        changed["services"]["billing-service"]["x-liveness"] = ["CMD", "node", "-e", "2"]
        _, objs = self.run_render(changed)
        c = by_kind(objs, "Deployment", "billing-service")["spec"]["template"]["spec"]["containers"][0]
        self.assertEqual(c["readinessProbe"]["exec"]["command"], ["node", "-e", "1"])
        self.assertEqual(c["livenessProbe"]["exec"]["command"], ["node", "-e", "2"])
        self.assertEqual(c["startupProbe"]["exec"]["command"], ["node", "-e", "2"])
        self.assertEqual(c["livenessProbe"]["failureThreshold"], 3)

    def test_without_x_liveness_every_probe_is_the_healthcheck(self):
        _, objs = self.run_render()
        c = by_kind(objs, "Deployment", "billing-service")["spec"]["template"]["spec"]["containers"][0]
        self.assertEqual(c["livenessProbe"]["exec"]["command"], ["node", "-e", "1"])

    # K6 (OPS-1-o-d): the startup probe allows what compose does — the start period,
    # then `retries` misses after it. A threshold of the start period alone gave
    # main-db one probe, so a first initdb or a crash recovery was killed mid-way.
    def test_a_slow_start_is_not_killed(self):
        _, objs = self.run_render()
        db = by_kind(objs, "StatefulSet", "main-db")["spec"]["template"]["spec"]["containers"][0]
        startup = db["startupProbe"]
        self.assertEqual(startup["periodSeconds"] * startup["failureThreshold"], 10 + 5 * 10)

    # K6 (OPS-1-o-i): with no start period, Docker runs the first check after one
    # interval, and so do the probes. At t=0 rabbitmq's probe, as root, wrote the
    # Erlang cookie into the empty claim before the server could, and it crashed.
    def test_first_check_waits_one_interval(self):
        m = copy.deepcopy(self.model)
        del m["services"]["billing-service"]["healthcheck"]["start_period"]
        _, objs = self.run_render(m)
        c = by_kind(objs, "Deployment", "billing-service")["spec"]["template"]["spec"]["containers"][0]
        self.assertNotIn("startupProbe", c)
        self.assertEqual([c[p]["initialDelaySeconds"] for p in ("readinessProbe", "livenessProbe")], [10, 10])

    # K7: named volume -> claim, host dir -> hostPath, secret file -> Secret.
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
        self.assertEqual(claims, {"postgres-data"})
        # H17's cache is each pod's own (K7): nothing to share between nodes.
        self.assertEqual({v["name"]: v for v in api["volumes"]}["locale-cache"]["emptyDir"], {})

    # K17 (OPS-1-o-q): a pod holding a claim or a host path stays on the data node,
    # since a local-path volume binds where its first pod runs and never follows it.
    def test_state_is_pinned_to_the_data_node(self):
        m = copy.deepcopy(self.model)
        m["services"]["guide-media"] = {
            "image": "nginx:1.27", "healthcheck": {"test": ["CMD", "true"], "interval": "10s"},
            "volumes": [{"type": "volume", "source": "object_storage", "target": "/data/objects", "read_only": True}]}
        m["services"]["promtail"] = {
            "image": "grafana/promtail:3.1.0", "healthcheck": {"test": ["CMD", "true"], "interval": "10s"},
            "volumes": [{"type": "bind", "source": "/var/log/pods", "target": "/var/log/pods", "read_only": True}]}
        m["volumes"]["object_storage"] = {}
        _, objs = self.run_render(m)
        selector = {"txnet.io/data": "true"}
        spec = lambda kind, name: by_kind(objs, kind, name)["spec"]["template"]["spec"]
        self.assertEqual(spec("StatefulSet", "main-db")["nodeSelector"], selector)
        self.assertEqual(spec("Deployment", "guide-media")["nodeSelector"], selector)
        self.assertNotIn("nodeSelector", spec("Deployment", "billing-service"))
        self.assertNotIn("nodeSelector", spec("DaemonSet", "promtail"))

    # K17: one label, written where the server registers, where join sets it and
    # where deploy asks for it — the render's table is held equal to all three.
    def test_one_data_label_everywhere(self):
        label = "=".join(DATA_NODE_LABEL)
        config = yaml.safe_load((REPO / "k8s/k3s/config.yaml").read_text())
        self.assertEqual(config["node-label"], [label])
        for script in ("scripts/k8s-add-node.sh", "scripts/prod.k8s.sh"):
            self.assertIn(f"\nDATA_LABEL={label}\n", (REPO / script).read_text(), script)

    # K10 (OPS-1-o-f): a release is a new tag for every image, so the kubelet asks
    # the registry for all 22. One at a time, the last waited ~3 min in the queue
    # on the test server and five rollouts missed their 300s.
    def test_the_node_pulls_images_in_parallel(self):
        config = yaml.safe_load((REPO / "k8s/k3s/config.yaml").read_text())
        args = dict(a.split("=", 1) for a in config.get("kubelet-arg", []))
        self.assertEqual(args.get("serialize-image-pulls"), "false")
        # Not a kubelet flag in 1.34: the kubelet exits, and k3s with it.
        self.assertNotIn("max-parallel-image-pulls", args)

    # K7 (OPS-1-o-v): a source tree is dev's (docker-compose.dev.yml). In the
    # production model it would hide the image's own code, so it fails the render.
    def test_a_source_tree_fails_the_render(self):
        for volume in ({"type": "bind", "source": str(self.repo / "txnet-backend"), "target": "/app"},
                       {"type": "volume", "target": "/app/node_modules"}):
            broken = copy.deepcopy(self.model)
            broken["services"]["billing-service"]["volumes"].append(volume)
            with self.assertRaisesRegex(RenderError, "billing-service.*/app"):
                self.run_render(broken)

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
        # K19: requested apart from the limit, or Kubernetes requests the limit itself.
        self.assertEqual(tpl["spec"]["containers"][0]["resources"]["requests"]["memory"], "167772160")
        self.assertIn("kustomization.yaml", files)


REPO = Path(__file__).resolve().parent.parent
# K10: what a rollout waits; main-db recovering inside it is not killed for it.
MAIN_DB_RECOVERY_S = 300


def render_cli(*args: str) -> subprocess.CompletedProcess:
    with tempfile.TemporaryDirectory() as out:
        return subprocess.run([sys.executable, str(REPO / "tools/k8s_render.py"), f"{out}/base", "--tag", "t1",
                               *args], capture_output=True, text=True)


# K2 before compose runs (OPS-1-o-u, -w): what the env files lack is named, and
# nothing is written. No real env file is read, so no value can reach the output.
@unittest.skipUnless(shutil.which("docker"), "needs docker compose")
class EnvFilesTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def env_file(self, name: str, text: str) -> str:
        (self.dir / name).write_text(text)
        return str(self.dir / name)

    def test_a_missing_env_file_is_named_with_what_it_sets(self):
        present = self.env_file("base.env", "DOMAIN_NAME=example.test\n")
        run = render_cli("--stack", "monitoring", "--env-file", present, "--env-file", str(self.dir / "absent.env"))
        self.assertEqual(run.returncode, 1, run.stderr)
        self.assertIn("absent.env is missing", run.stderr)
        self.assertIn("GRAFANA_ADMIN_PASS", run.stderr)
        self.assertNotIn("DOMAIN_NAME", run.stderr.split("missing", 1)[1])
        self.assertNotIn("Traceback", run.stderr)

    # Compose turns an unset ${DB_APP_PASSWORD} into "", and every service then fails P1000.
    def test_a_blank_database_password_is_refused(self):
        env = self.env_file("blank.env", "DB_APP_PASSWORD=\nDB_CROSS_TENANT_PASSWORD=set-but-not-blank\n")
        run = render_cli("--env-file", env)
        self.assertEqual(run.returncode, 1, run.stderr)
        named = run.stderr.split("blank", 1)[0]
        self.assertIn("DB_APP_PASSWORD", named)
        self.assertIn("DB_AI_READER_PASSWORD", named)
        self.assertNotIn("DB_CROSS_TENANT_PASSWORD", named)
        self.assertNotIn("set-but-not-blank", run.stderr)


# K4 at HEAD (OPS-1-o-h): the miniature above cannot see a call one real service
# makes to another, so the repo's own production model is rendered too. It needs
# docker's compose CLI and the env files; without them it is skipped, not passed.
@unittest.skipUnless(shutil.which("docker") and (REPO / ".env").exists() and (REPO / ".env.prod").exists(),
                     "needs docker compose and the repo's .env / .env.prod")
class RepoModelTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with tempfile.TemporaryDirectory() as out:
            cls.result = subprocess.run([sys.executable, str(REPO / "tools/k8s_render.py"), f"{out}/base",
                                         "--host-gateway", "10.0.0.5", "--tag", "t1"],
                                        capture_output=True, text=True)
            cls.objects = [o for f in Path(out, "base").rglob("*.yaml") for o in yaml.safe_load_all(f.read_text())
                           if o] if cls.result.returncode == 0 else []

    def test_the_production_model_renders(self):
        self.assertEqual(self.result.returncode, 0, self.result.stderr)

    # H15, H24 (OPS-1-aa): every container is checked, so every rollout waits on health (K6).
    def test_every_container_is_probed(self):
        unprobed = [c["name"] for o in self.objects if o["kind"] in ("Deployment", "StatefulSet")
                    for c in o["spec"]["template"]["spec"]["containers"] if "livenessProbe" not in c]
        self.assertTrue(self.objects)
        self.assertEqual(unprobed, [])

    # H25 (LIVE-1-r): on the real model — through `docker compose config` — a
    # Node service's liveness accepts any answer and its readiness keeps the
    # database check. The JSON form drops `x-` keys; a model-only test missed it
    # and the first release still killed services on a main-db outage.
    def test_a_node_service_lives_by_any_answer_and_is_ready_by_the_database(self):
        c = next(o for o in self.objects if o["kind"] == "Deployment"
                 and o["metadata"]["name"] == "billing-service")["spec"]["template"]["spec"]["containers"][0]
        live, ready = c["livenessProbe"]["exec"]["command"][-1], c["readinessProbe"]["exec"]["command"][-1]
        self.assertIn("then(()=>process.exit(0)", live)
        self.assertIn("r.ok?0:1", ready)
        self.assertEqual(c["startupProbe"]["exec"]["command"][-1], live)

    # K6 (OPS-1-o-f): a probe that fails kills, where Docker's only marks. On the
    # test server main-db's crash recovery fsyncs its data directory for over a
    # minute, and the 60s startup budget killed each recovery mid-way, in a loop.
    def test_main_db_recovers_before_its_startup_probe_kills_it(self):
        db = next(o for o in self.objects if o["kind"] == "StatefulSet" and o["metadata"]["name"] == "main-db")
        startup = db["spec"]["template"]["spec"]["containers"][0]["startupProbe"]
        self.assertGreaterEqual(startup["periodSeconds"] * startup["failureThreshold"], MAIN_DB_RECOVERY_S)

    # K6 (OPS-1-o-f): a pod Traefik routes to keeps serving until Traefik has
    # dropped it. Without the pause, rolling billing-service under load answered
    # 4 of 10060 requests 502 on the test server: SIGTERM beat the endpoint update.
    def test_a_routed_pod_drains_before_it_stops(self):
        routed = {s["name"] for o in self.objects if o["kind"] == "IngressRoute"
                  for r in o["spec"]["routes"] for s in r.get("services", [])}
        pods = {o["metadata"]["name"]: o["spec"]["template"]["spec"] for o in self.objects
                if o["kind"] == "Deployment" and o["metadata"]["name"] in routed}
        self.assertIn("billing-service", pods)
        for name, pod in pods.items():
            drain = pod["containers"][0].get("lifecycle", {}).get("preStop", {}).get("sleep", {}).get("seconds", 0)
            self.assertGreater(drain, 0, name)
            self.assertGreater(pod["terminationGracePeriodSeconds"], drain, name)

    # R13 (OPS-1-o-x): an empty database has no platform tenant until seed.js runs,
    # and auth-service does not start without one. Every release seeds after the
    # migrations; the owner's password is read from a mounted file, never env.
    def test_every_release_seeds_after_its_migrations(self):
        job = next(o for o in self.objects if o["kind"] == "Job" and o["metadata"]["name"] == "db-migrate")
        pod = job["spec"]["template"]["spec"]
        command = " ".join(pod["containers"][0].get("command", []) + pod["containers"][0].get("args", []))
        self.assertRegex(command, r"prisma migrate deploy .*&& node prisma/seed\.js")
        env = next(o for o in self.objects if o["kind"] == "Secret"
                   and o["metadata"]["name"] == pod["containers"][0]["envFrom"][0]["secretRef"]["name"])["data"]
        self.assertIn("DOMAIN_NAME", env)
        password_file = base64.b64decode(env["PLATFORM_OWNER_PASSWORD_FILE"]).decode()
        mounts = [m["mountPath"] for m in pod["containers"][0]["volumeMounts"]]
        self.assertIn(password_file, mounts)

    # K5 (OPS-1-o-i): a value that is a Secret in one pod is written in no pod
    # spec — memory-data's password reached its args and probe from compose.
    def test_no_secret_value_in_a_pod_spec(self):
        secret = re.compile(r"^(?!.*_FILE$).*(PASS|SECRET|TOKEN|_KEY$)")  # a *_FILE names a path
        values = {base64.b64decode(v).decode() for o in self.objects if o["kind"] == "Secret"
                  for k, v in (o.get("data") or {}).items() if secret.search(k)}
        values = {v for v in values if len(v) >= 8}
        leaks = sorted({o["metadata"]["name"] for o in self.objects if o["kind"] in ("Deployment", "StatefulSet")
                        for v in values if v in yaml.safe_dump(o["spec"]["template"]["spec"])})
        self.assertTrue(values)
        self.assertEqual(leaks, [])


if __name__ == "__main__":
    unittest.main()
