#!/usr/bin/env python3
"""Spec for the monitoring stack on Kubernetes (OPS-1-o-e, hosting K11).

The sys-monitor compose file is rendered like the main one, into
`txnet-monitoring`; Promtail is a DaemonSet on /var/log/pods; Prometheus scrapes
by the same Service names, the main stack's reached across namespaces.

    python3 tools/k8s_render_monitoring_test.py
"""
import base64
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml

sys.path.insert(0, str(Path(__file__).parent))
from k8srender import RenderError, render  # noqa: E402
from k8srender.tables import MONITORING_NAMESPACE, NAMESPACE  # noqa: E402
from k8srender.traefik import as_edge  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
PEER = {"namespace": NAMESPACE, "exposed": {"rabbitmq": {5672, 15692}, "main-db": {5432}}}
OPTIONS = {"registry": "registry.example", "tag": "t1", "namespace": MONITORING_NAMESPACE, "peer": PEER,
           "publish": False}

PROMETHEUS_YML = """
alerting:
  alertmanagers:
    - static_configs:
        - targets: ["alertmanager:9093"]
rule_files: ["/etc/prometheus/automation.rules.yml"]
scrape_configs:
  - job_name: prometheus
    static_configs: [{targets: ["localhost:9090"]}]
  - job_name: cadvisor
    static_configs: [{targets: ["cadvisor:8080"]}]
  - job_name: rabbitmq
    static_configs: [{targets: ["rabbitmq:15692"]}]
"""
RULES_YML = "groups:\n  - name: automation\n    rules: []  # kept byte for byte\n"
PROMTAIL_YAML = """
server: {http_listen_port: 9080}
positions: {filename: /tmp/positions.yaml}
clients: [{url: "http://loki:3100/loki/api/v1/push"}]
scrape_configs:
  - job_name: docker_txnet
    docker_sd_configs: [{host: "unix:///var/run/docker.sock"}]
    relabel_configs:
      - {source_labels: ["__meta_docker_container_label_txnet_logging"], regex: "true", action: keep}
    pipeline_stages:
      - json: {expressions: {level: level}}
      - labels: {level: null}
"""


def model(repo: Path) -> dict:
    """A miniature sys-monitor stack: Prometheus, cAdvisor, Promtail, Loki, Alertmanager, an exporter."""
    cfg = repo / "dev-docker/monitoring/config-dev"
    return {
        "configs": {"prometheus_config": {"file": str(cfg / "prometheus.yml")},
                    "automation_rules": {"file": str(cfg / "automation.rules.yml")},
                    "promtail_config": {"file": str(cfg / "promtail.yaml")}},
        "secrets": {"bale_token": {"file": str(cfg / "bale_token.txt")}},
        "services": {
            "prometheus": {
                "image": "prom/prometheus:v2.53.0", "expose": ["9090"], "ports": [{"target": 9090, "published": "9090"}],
                "configs": [{"source": "prometheus_config", "target": "/etc/prometheus/prometheus.yml"},
                            {"source": "automation_rules", "target": "/etc/prometheus/automation.rules.yml"}],
                "volumes": [{"type": "volume", "source": "prometheus_data", "target": "/prometheus"}],
            },
            "alertmanager": {
                "image": "prom/alertmanager:v0.27.0", "expose": ["9093"],
                "ports": [{"target": 9093, "published": "9093"}], "secrets": [{"source": "bale_token"}],
            },
            "cadvisor": {
                "image": "cadvisor/cadvisor:latest", "ports": [{"target": 8080, "published": "8080"}],
                "volumes": [{"type": "bind", "source": "/var/run/docker.sock", "target": "/var/run/docker.sock"}],
            },
            "promtail": {
                "image": "grafana/promtail:3.1.0", "command": ["-config.file=/etc/promtail/promtail.yaml"],
                "configs": [{"source": "promtail_config", "target": "/etc/promtail/promtail.yaml"}],
                "volumes": [
                    {"type": "bind", "source": "/var/lib/docker/containers", "target": "/var/lib/docker/containers",
                     "read_only": True},
                    {"type": "bind", "source": "/var/run/docker.sock", "target": "/var/run/docker.sock"},
                ],
            },
            "node-exporter": {
                "image": "prom/node-exporter:latest", "expose": ["9100"],
                "volumes": [{"type": "bind", "source": "/", "target": "/rootfs", "read_only": True},
                            {"type": "bind", "source": "/proc", "target": "/host/proc", "read_only": True}],
            },
            "postgres-exporter": {
                "image": "prometheuscommunity/postgres-exporter:v0.15.0", "expose": ["9187"],
                "environment": {"DATA_SOURCE_NAME": "postgresql://u:p@main-db:5432/db?sslmode=disable"},
            },
        },
    }


def objects_of(files: dict) -> list:
    return [o for objs in files.values() if isinstance(objs, list) for o in objs]


def find(objects: list, kind: str, name: str) -> dict:
    return next(o for o in objects if o["kind"] == kind and o["metadata"]["name"].startswith(name))


def pod_of(objects: list, name: str) -> dict:
    return next(o for o in objects if o["kind"] in ("Deployment", "DaemonSet", "StatefulSet")
                and o["metadata"]["name"] == name)["spec"]["template"]["spec"]


def config_text(objects: list, pod: dict, mount_path: str) -> str:
    mount = next(m for m in pod["containers"][0]["volumeMounts"] if m["mountPath"] == mount_path)
    volume = next(v for v in pod["volumes"] if v["name"] == mount["name"])
    return find(objects, "ConfigMap", volume["configMap"]["name"])["data"][mount["subPath"]]


class MonitoringTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.repo = Path(self.tmp.name)
        cfg = self.repo / "dev-docker/monitoring/config-dev"
        cfg.mkdir(parents=True)
        (cfg / "prometheus.yml").write_text(PROMETHEUS_YML)
        (cfg / "automation.rules.yml").write_text(RULES_YML)
        (cfg / "promtail.yaml").write_text(PROMTAIL_YAML)
        (cfg / "bale_token.txt").write_text("123:abc\n")
        self.model = model(self.repo)

    def tearDown(self):
        self.tmp.cleanup()

    def run_render(self, m=None, options=None):
        files = render(m or self.model, self.repo, options or OPTIONS)
        return files, objects_of(files)

    def test_every_object_is_in_the_monitoring_namespace(self):
        files, objects = self.run_render()
        self.assertEqual(files["kustomization.yaml"]["namespace"], MONITORING_NAMESPACE)
        self.assertEqual(find(objects, "Namespace", "txnet")["metadata"]["name"], MONITORING_NAMESPACE)

    # The alert rules are unchanged (K11): a compose config is its file, verbatim.
    def test_a_compose_config_is_a_configmap_at_its_target(self):
        _, objects = self.run_render()
        pod = pod_of(objects, "prometheus")
        self.assertEqual(config_text(objects, pod, "/etc/prometheus/automation.rules.yml"), RULES_YML)

    def test_a_compose_secret_is_a_secret_under_run_secrets(self):
        _, objects = self.run_render()
        pod = pod_of(objects, "alertmanager")
        mount = next(m for m in pod["containers"][0]["volumeMounts"] if m["mountPath"] == "/run/secrets/bale_token")
        self.assertTrue(mount["readOnly"])
        secret = find(objects, "Secret", "secret-bale-token")
        self.assertEqual(base64.b64decode(secret["data"]["bale_token"]).decode(), "123:abc\n")

    # K3: Prometheus's TSDB takes a lock; a second pod on the claim would wait on
    # it until the rollout's deadline. One pod, stopped before the next starts.
    def test_a_monitoring_store_stops_before_it_starts(self):
        _, objects = self.run_render()
        self.assertEqual(find(objects, "StatefulSet", "prometheus")["spec"]["serviceName"], "prometheus")

    # node-exporter reads the host's root; a volume name must still be a DNS label.
    def test_the_host_root_is_a_named_host_path(self):
        _, objects = self.run_render()
        volumes = {v["hostPath"]["path"]: v["name"] for v in pod_of(objects, "node-exporter")["volumes"]}
        self.assertEqual(volumes, {"/": "host-root", "/proc": "host-proc"})

    # Prometheus and Alertmanager have no login: they are never on the node's address.
    def test_published_ports_stay_inside_the_cluster(self):
        _, objects = self.run_render()
        services = [o for o in objects if o["kind"] == "Service"]
        self.assertFalse([s["metadata"]["name"] for s in services if s["spec"]["type"] == "LoadBalancer"])
        self.assertEqual(find(objects, "Service", "prometheus")["spec"]["ports"][0]["port"], 9090)

    def test_promtail_is_a_daemonset_reading_pod_logs(self):
        _, objects = self.run_render()
        self.assertEqual(find(objects, "DaemonSet", "promtail")["kind"], "DaemonSet")
        pod = pod_of(objects, "promtail")
        volumes = {v["name"]: v for v in pod["volumes"]}
        mounts = {m["mountPath"]: m for m in pod["containers"][0]["volumeMounts"]}
        self.assertTrue(mounts["/var/log/pods"]["readOnly"])
        self.assertEqual(volumes[mounts["/var/log/pods"]["name"]]["hostPath"]["path"], "/var/log/pods")
        self.assertNotIn("/var/lib/docker/containers", mounts)
        self.assertNotIn("/var/run/docker.sock", mounts)
        env = {e["name"]: e for e in pod["containers"][0]["env"]}
        # Promtail keeps the pods whose __host__ is its own HOSTNAME: the node's name.
        self.assertEqual(env["HOSTNAME"]["valueFrom"]["fieldRef"]["fieldPath"], "spec.nodeName")
        self.assertEqual(pod["serviceAccountName"], "promtail")

    def test_promtail_finds_pods_by_their_logging_label(self):
        _, objects = self.run_render()
        config = yaml.safe_load(config_text(objects, pod_of(objects, "promtail"), "/etc/promtail/promtail.yaml"))
        job = config["scrape_configs"][0]
        self.assertEqual(job["kubernetes_sd_configs"], [{"role": "pod"}])
        self.assertIn({"source_labels": ["__meta_kubernetes_pod_label_txnet_io_logging"], "regex": "true",
                       "action": "keep"}, job["relabel_configs"])
        self.assertTrue(any(r.get("target_label") == "__path__" and r["replacement"].startswith("/var/log/pods/")
                            for r in job["relabel_configs"]))
        # A pod log line is CRI-framed; H13's `level` label is read after the frame.
        self.assertEqual(job["pipeline_stages"][0], {"cri": {}})
        self.assertEqual(job["pipeline_stages"][1:], yaml.safe_load(PROMTAIL_YAML)["scrape_configs"][0]["pipeline_stages"])
        self.assertEqual(config["clients"], [{"url": "http://loki:3100/loki/api/v1/push"}])

    # Prometheus scrapes `rabbitmq:15692` as today; the name resolves into `txnet`.
    def test_a_main_stack_service_is_reached_by_its_name(self):
        _, objects = self.run_render()
        for name in ("rabbitmq", "main-db"):
            service = find(objects, "Service", name)
            self.assertEqual(service["spec"], {"type": "ExternalName",
                                               "externalName": f"{name}.{NAMESPACE}.svc.cluster.local"})
        self.assertNotIn("memory-data", {o["metadata"]["name"] for o in objects if o["kind"] == "Service"})

    # K4: a scrape that would fail at run time fails the render.
    def test_a_scrape_target_the_main_stack_does_not_expose_fails(self):
        options = {**OPTIONS, "peer": {**PEER, "exposed": {**PEER["exposed"], "rabbitmq": {5672}}}}
        with self.assertRaisesRegex(RenderError, r"prometheus: calls rabbitmq:15692"):
            self.run_render(options=options)

    # A target in this stack gets a Service only from its `expose:` (K4).
    def test_a_scrape_target_this_stack_does_not_expose_fails(self):
        del self.model["services"]["alertmanager"]["expose"]
        with self.assertRaisesRegex(RenderError, r"prometheus: calls alertmanager:9093"):
            self.run_render()

    def test_a_scrape_target_nobody_serves_fails(self):
        (self.repo / "dev-docker/monitoring/config-dev/prometheus.yml").write_text(
            PROMETHEUS_YML + "  - job_name: gone\n    static_configs: [{targets: [\"nowhere:1\"]}]\n")
        with self.assertRaisesRegex(RenderError, r"prometheus: scrapes nowhere:1"):
            self.run_render()

    # The kubelet serves cAdvisor's metrics for every pod; a Docker-only cAdvisor sees none.
    def test_cadvisor_gives_way_to_the_kubelets(self):
        _, objects = self.run_render()
        self.assertFalse([o for o in objects if o["metadata"]["name"].startswith("cadvisor")])
        pod = pod_of(objects, "prometheus")
        config = yaml.safe_load(config_text(objects, pod, "/etc/prometheus/prometheus.yml"))
        jobs = {j["job_name"]: j for j in config["scrape_configs"]}
        self.assertNotIn("cadvisor", jobs)
        kubelet = next(j for j in jobs.values() if j.get("metrics_path") == "/metrics/cadvisor")
        self.assertEqual(kubelet["kubernetes_sd_configs"], [{"role": "node"}])
        # k3s signs each kubelet's serving certificate with the CA every pod's
        # service account carries, so the scrape is verified (2026-10-24, in k3s).
        self.assertEqual(kubelet["tls_config"], {"ca_file": "/var/run/secrets/kubernetes.io/serviceaccount/ca.crt"})
        self.assertEqual(config["rule_files"], ["/etc/prometheus/automation.rules.yml"])
        self.assertEqual(pod["serviceAccountName"], "prometheus")

    # Grafana's IngressRoute lives in txnet-monitoring; Traefik must read it there.
    def test_traefik_reads_both_namespaces(self):
        pod = {"containers": [{"args": ["--providers.docker=true", "--entrypoints.web.address=:80"]}]}
        as_edge(pod)
        self.assertIn(f"--providers.kubernetescrd.namespaces={NAMESPACE},{MONITORING_NAMESPACE}",
                      pod["containers"][0]["args"])


# The repo's own monitoring stack, read through compose like the main one.
# Without docker or the env files it is skipped, not passed.
ENV_FILES = [".env", ".env.prod", "dev-docker/monitoring/.env.dev"]


@unittest.skipUnless(shutil.which("docker") and all((REPO / f).exists() for f in ENV_FILES),
                     "needs docker compose and the repo's env files")
class RepoMonitoringTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        with tempfile.TemporaryDirectory() as out:
            args = [a for f in ENV_FILES for a in ("--env-file", f)]
            cls.result = subprocess.run([sys.executable, str(REPO / "tools/k8s_render.py"), f"{out}/base",
                                         "--stack", "monitoring", "--tag", "t1", *args],
                                        capture_output=True, text=True, cwd=REPO)
            cls.objects = [o for f in Path(out, "base").glob("*.yaml") for o in yaml.safe_load_all(f.read_text())
                           if o] if cls.result.returncode == 0 else []

    def test_the_monitoring_stack_renders(self):
        self.assertEqual(self.result.returncode, 0, self.result.stderr)

    def test_the_alert_rules_are_the_files_themselves(self):
        data = {k: v for o in self.objects if o["kind"] == "ConfigMap" for k, v in o["data"].items()}
        rules = sorted((REPO / "dev-docker/monitoring/config-dev").glob("*.rules.yml"))
        self.assertTrue(rules)
        for path in rules:
            self.assertEqual(data.get(path.name), path.read_text(), path.name)


if __name__ == "__main__":
    unittest.main()
