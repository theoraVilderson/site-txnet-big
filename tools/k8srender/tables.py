"""The facts only Kubernetes has, which the compose files cannot say (hosting K2).

This is their one home. Everything else comes from the compose model; a fact
that could live in compose belongs there instead (K4's `expose:` is one).
"""
from dataclasses import dataclass


@dataclass(frozen=True)
class Stack:
    """One compose project rendered into one namespace (K2, K11)."""
    compose: str  # repo-relative
    project: str
    env_files: tuple  # repo-relative, read in order as compose's --env-file
    namespace: str
    # K8: profiles whose services are rendered too.
    profiles: tuple = ()
    # K11: a published port is a LoadBalancer on the node's address, or (False)
    # nothing: the monitoring stack has no login, so it stays inside the cluster.
    publish: bool = True
    # K11: the stack whose Services this one calls by name, across namespaces.
    peer: str | None = None


# K1: the namespace every platform object lives in, and K11's for monitoring.
NAMESPACE = "txnet"
MONITORING_NAMESPACE = "txnet-monitoring"
# K11: what a Service name resolves under across namespaces (k3s's default).
CLUSTER_DOMAIN = "cluster.local"

# K2, K11: `migrate` holds db-migrate, which `up` must never start but
# `deploy` runs as a Job (K8). The monitoring env file holds Grafana's login.
STACKS = {
    "main": Stack("dev-docker/docker-compose.main.yml", "txnet", (".env", ".env.prod"), NAMESPACE,
                  profiles=("migrate",)),
    "monitoring": Stack("dev-docker/monitoring/docker-compose.sys-monitor.yml", "txnet-monitor",
                        (".env", ".env.prod", "dev-docker/monitoring/.env.prod"), MONITORING_NAMESPACE,
                        publish=False, peer="main"),
}

# K3: one pod, its claim, a stop before the start — two writers corrupt a volume.
# K11's three hold a lock or a SQLite file on theirs: Prometheus, Loki, Grafana.
STATEFUL = {"main-db", "memory-data", "rabbitmq", "prometheus", "loki", "grafana"}

# K3: a service that runs as a second container in another service's pod.
# pg-backup reaches Postgres over the shared socket only (H3).
SIDECARS = {"pg-backup": "main-db"}

# K3, K7: a named volume private to one pod — pg-backup's socket (H3), and
# H17's translation cache: each service writes its own `<scope>.<lang>.json`,
# so a shared claim would only tie every Node service to one node (K17).
POD_LOCAL_VOLUMES = {"pg_socket", "locale_cache"}

# K17: the node a pod holding a claim or a host path runs on. A local-path
# volume binds on the node of its first pod and cannot follow it; Traefik also
# stays there, the one address Cloudflare reaches. Written by k8s/k3s/config.yaml
# and k8s-add-node.sh `join`, asked for by prod.k8s.sh (the render test holds them equal).
DATA_NODE_LABEL = ("txnet.io/data", "true")

# K7: requested sizes; local-path does not enforce them, a later class may.
VOLUME_SIZES = {
    "postgres_data": "50Gi",
    "object_storage": "20Gi",
    "translator_llm_models": "10Gi",
    "rabbitmq_data": "5Gi",
    "redis_vol_internal": "2Gi",
}
DEFAULT_VOLUME_SIZE = "1Gi"

# K7, K11: Docker's own state, bound by the containers that read it (Traefik's
# Docker provider, Promtail). A k3s node runs containerd: mounted, it is empty.
DOCKER_HOST_BINDS = {"/var/run/docker.sock", "/var/lib/docker/containers"}

# K11: the compose services that ship logs and scrape metrics, whose config
# files monitoring.py rewrites for Kubernetes.
LOG_SHIPPER, SCRAPER = "promtail", "prometheus"

# K11: a workload on every node rather than one replica: each node's pod logs.
DAEMONSETS = {LOG_SHIPPER}

# K11: the pods that read the Kubernetes API, as the service account
# k8s/monitoring/rbac.yaml grants it to: Promtail lists pods, Prometheus nodes.
SERVICE_ACCOUNTS = {LOG_SHIPPER: "promtail", SCRAPER: "prometheus"}

# K11 (user, 2026-10-24): a compose service Kubernetes already provides, not
# rendered. cAdvisor runs `--docker_only`, which sees no pod; the kubelet
# serves the same metrics for every container (monitoring.py's scrape job).
PROVIDED_BY_KUBERNETES = {"cadvisor"}

# K8/K9: bound directories copied into an image instead of mounted, and the
# Dockerfile that copies each (tools/k8s_deploy_test.py holds the two together).
BAKED_BINDS = {
    "locales": "i18n-platform/services/locale-service/Dockerfile",
    "dev-docker/traefik/dynamic": "dev-docker/traefik/Dockerfile",
    "dev-docker/traefik/plugins-local": "dev-docker/traefik/Dockerfile",
    "dev-docker/traefik/origin-pull": "dev-docker/traefik/Dockerfile",
}

# K9: the compose service that is Traefik, and what changes in its pod: the
# Docker provider's flags give way to the CRD provider's, read as the
# service account k8s/traefik/ binds to Traefik's ClusterRole.
TRAEFIK = "gateway-handler"
# NIN-1-b4 (ADR-0165 amendment 2): one Traefik for every edge.
EDGE_GATEWAYS = {TRAEFIK}
TRAEFIK_SERVICE_ACCOUNT = "traefik-ingress-controller"
TRAEFIK_DROPPED_ARG = "--providers.docker"
TRAEFIK_PROVIDER_ARGS = ["--providers.kubernetescrd=true"]

# K7: a bound file under this directory is a Secret, any other a ConfigMap.
SECRET_DIR = "dev-docker/secrets"

# K3 (`restart`): values whose meaning is the pod default, restart always.
ALWAYS_RESTART = {None, "always", "unless-stopped"}

# K2: compose keys with nothing to map — each says why.
DROPPED_KEYS = {
    "container_name",  # a pod is named by its workload
    "depends_on",  # K3: the probe and the restart do the waiting
    "networks",  # one private network today; every pod shares the cluster's
    "logging",  # the kubelet rotates container logs (K1)
    "memswap_limit",  # Kubernetes runs without swap
    "build",  # read for the image name (K8), not a pod field
    "profiles",  # K8: chose which services compose printed; Stack.profiles above
}
