"""K11: the monitoring stack on Kubernetes. Promtail reads every pod's log on
its node, Prometheus reads the kubelet's cAdvisor, and a scrape target is a
call like any K4 one: it must answer, here or in the peer stack."""
from pathlib import Path

import yaml

from .objects import RenderError, port_number
from .tables import CLUSTER_DOMAIN, LOG_SHIPPER, PROVIDED_BY_KUBERNETES, SCRAPER

# The config files rewritten, by the mount target compose gives them.
PROMETHEUS_CONFIG = "/etc/prometheus/prometheus.yml"
PROMTAIL_CONFIG = "/etc/promtail/promtail.yaml"

# Where the kubelet writes container logs: <ns>_<pod>_<uid>/<container>/N.log.
POD_LOGS = "/var/log/pods"
# Promtail's read offsets, kept on the node: in the container's /tmp a new pod
# would read every log from the start, and Loki would take each line twice.
POSITIONS_DIR, POSITIONS_MOUNT = "/var/lib/txnet/promtail", "/run/promtail"

_SA = "/var/run/secrets/kubernetes.io/serviceaccount"
# The kubelet's cAdvisor, on every node, as the service account allowed
# `nodes/metrics` (k8s/monitoring/rbac.yaml). k3s signs each kubelet's serving
# certificate (its node address in the SAN) with the CA every service account
# carries, so the scrape is verified.
KUBELET_CADVISOR_JOB = {
    "job_name": "kubelet-cadvisor",
    "scheme": "https",
    "metrics_path": "/metrics/cadvisor",
    "authorization": {"credentials_file": f"{_SA}/token"},
    "tls_config": {"ca_file": f"{_SA}/ca.crt"},
    "kubernetes_sd_configs": [{"role": "node"}],
}

# One job for every pod labelled for logging (K11: compose's txnet.logging=true
# is the pod label txnet.io/logging). `service` is the container's name, which
# is the compose service's, so a query reads as it did under Docker.
POD_LOG_RELABELS = [
    {"source_labels": ["__meta_kubernetes_pod_label_txnet_io_logging"], "regex": "true", "action": "keep"},
    # Promtail keeps only the targets whose __host__ is its HOSTNAME: its node.
    {"source_labels": ["__meta_kubernetes_pod_node_name"], "target_label": "__host__"},
    {"source_labels": ["__meta_kubernetes_pod_name"], "target_label": "container_name"},
    {"source_labels": ["__meta_kubernetes_pod_container_name"], "target_label": "service"},
    {"source_labels": ["__meta_kubernetes_pod_uid", "__meta_kubernetes_pod_container_name"], "separator": "/",
     "replacement": f"{POD_LOGS}/*$1/*.log", "target_label": "__path__"},
]


def rewrite(service: str, target: str, text: str) -> str:
    """A compose config file as this service reads it on Kubernetes."""
    if (service, target) == (SCRAPER, PROMETHEUS_CONFIG):
        return _prometheus(text)
    if (service, target) == (LOG_SHIPPER, PROMTAIL_CONFIG):
        return _promtail(text)
    return text


def _prometheus(text: str) -> str:
    """A job scraping a service Kubernetes provides gives way to the kubelet's."""
    config = yaml.safe_load(text)
    jobs = [j for j in config.get("scrape_configs") or []
            if not (_job_hosts(j) and _job_hosts(j) <= PROVIDED_BY_KUBERNETES)]
    if len(jobs) < len(config.get("scrape_configs") or []):
        jobs.append(KUBELET_CADVISOR_JOB)
    config["scrape_configs"] = jobs
    return yaml.safe_dump(config, sort_keys=False, width=120)


def _promtail(text: str) -> str:
    """Docker's discovery becomes the pods' on this node; the pipeline (H13) is
    kept, read after the CRI frame every kubelet log line carries."""
    config = yaml.safe_load(text)
    config["positions"] = {**(config.get("positions") or {}), "filename": f"{POSITIONS_MOUNT}/positions.yaml"}
    jobs = []
    for job in config.get("scrape_configs") or []:
        if "docker_sd_configs" in job:
            job = {"job_name": "kubernetes_pods", "kubernetes_sd_configs": [{"role": "pod"}],
                   "relabel_configs": POD_LOG_RELABELS,
                   "pipeline_stages": [{"cri": {}}, *(job.get("pipeline_stages") or [])]}
        jobs.append(job)
    config["scrape_configs"] = jobs
    return yaml.safe_dump(config, sort_keys=False, width=120)


def scrape_targets(text: str) -> list[str]:
    """Every `host:port` Prometheus calls: its scrape targets and Alertmanagers."""
    config = yaml.safe_load(text) or {}
    sections = [*(config.get("scrape_configs") or []), *((config.get("alerting") or {}).get("alertmanagers") or [])]
    return [t for s in sections for static in s.get("static_configs") or [] for t in static.get("targets") or []]


def _job_hosts(job: dict) -> set:
    return {t.rsplit(":", 1)[0] for static in job.get("static_configs") or [] for t in static.get("targets") or []}


def as_log_shipper(pod: dict) -> None:
    """Promtail's pod: the node's pod logs read-only, its offsets on the node,
    and HOSTNAME set to the node's name, which __host__ is compared with."""
    container = pod["containers"][0]
    pod.setdefault("volumes", []).extend([
        {"name": "pod-logs", "hostPath": {"path": POD_LOGS, "type": "Directory"}},
        {"name": "positions", "hostPath": {"path": POSITIONS_DIR, "type": "DirectoryOrCreate"}},
    ])
    container.setdefault("volumeMounts", []).extend([
        {"name": "pod-logs", "mountPath": POD_LOGS, "readOnly": True},
        {"name": "positions", "mountPath": POSITIONS_MOUNT},
    ])
    container["env"] = [{"name": "HOSTNAME", "valueFrom": {"fieldRef": {"fieldPath": "spec.nodeName"}}}]


def scrape_calls(services: dict, declared: dict, peer: dict | None) -> set:
    """K4 for what Prometheus scrapes, read as Kubernetes will run it; returns
    the peer services it calls. The main stack has no scraper: nothing."""
    called = set()
    for entry in (services.get(SCRAPER) or {}).get("configs") or []:
        if entry.get("target") == PROMETHEUS_CONFIG:
            text = Path(declared["configs"][entry["source"]]["file"]).read_text()
            targets = scrape_targets(rewrite(SCRAPER, PROMETHEUS_CONFIG, text))
            called |= check_scrapes(SCRAPER, targets, services, peer)
    return called


def check_scrapes(caller: str, targets: list[str], services: dict, peer: dict | None) -> set:
    """K4 for scrape targets: each answers in this stack or is exposed by the
    peer stack; returns the peer services called. A target nobody serves fails."""
    called = set()
    for target in targets:
        host, _, port = target.rpartition(":")
        if not port.isdigit():
            raise RenderError(f"{caller}: scrape target {target!r} names no port (K11)")
        if host == "localhost":
            continue
        if host in services:
            exposed = {port_number(p) for p in services[host].get("expose") or []}
        elif peer and host in peer["exposed"]:
            exposed = peer["exposed"][host]
            called.add(host)
        else:
            raise RenderError(f"{caller}: scrapes {target}, which no service serves (K4, K11)")
        if int(port) not in exposed:
            raise RenderError(f"{caller}: calls {target}, which {host} does not expose (K4)")
    return called


def peer_services(names: set, peer_namespace: str) -> list:
    """K11: the peer stack's Services by their own names in this namespace, so a
    config written for one compose network reads unchanged across two."""
    return [{"apiVersion": "v1", "kind": "Service", "metadata": {"name": name},
             "spec": {"type": "ExternalName", "externalName": f"{name}.{peer_namespace}.svc.{CLUSTER_DOMAIN}"}}
            for name in sorted(names)]
