"""The facts only Kubernetes has, which the compose files cannot say (hosting K2).

This is their one home. Everything else comes from the compose model; a fact
that could live in compose belongs there instead (K4's `expose:` is one).
"""

# K1: the namespace every platform object lives in.
NAMESPACE = "txnet"

# K3: one pod, its claim, a stop before the start — two writers corrupt a volume.
STATEFUL = {"main-db", "memory-data", "rabbitmq"}

# K3: a service that runs as a second container in another service's pod.
# pg-backup reaches Postgres over the shared socket only (H3).
SIDECARS = {"pg-backup": "main-db"}

# K3: a named volume private to one pod — pg-backup's socket (H3).
POD_LOCAL_VOLUMES = {"pg_socket"}

# K7: requested sizes; local-path does not enforce them, a later class may.
VOLUME_SIZES = {
    "postgres_data": "50Gi",
    "object_storage": "20Gi",
    "translator_models": "10Gi",
    "translator_llm_models": "10Gi",
    "rabbitmq_data": "5Gi",
    "redis_vol_internal": "2Gi",
}
DEFAULT_VOLUME_SIZE = "1Gi"

# K7: bound directories that exist for dev only. A source tree is in the
# `prod` image already; mounting it would run dev code in production.
DEV_ONLY_BINDS = {
    "txnet-backend",
    "coinsite",
    "site-pwa",
    "site-pwa/node_modules",
    "site-pwa/.next",
    "auth-handler",
    "i18n-platform/clients/go",
    "network-service",
    "sub-service",
    "/var/run/docker.sock",
}

# K8: bound directories another row turns into an image layer.
# The value is the row that does; until it lands the mount is left out.
LATER_BINDS = {
    "locales": "OPS-1-o-c",
}

# K8/K9: Traefik's file config, local plugins and origin-pull CA, copied into
# its image by dev-docker/traefik/Dockerfile instead of mounted.
BAKED_BINDS = {
    "dev-docker/traefik/dynamic",
    "dev-docker/traefik/plugins-local",
    "dev-docker/traefik/origin-pull",
}

# K7/K9: a bound directory that holds state, and the claim that holds it instead.
BIND_CLAIMS = {"dev_letsencrypt": "letsencrypt"}

# K9: the compose service that is Traefik, and what changes in its pod: the
# Docker provider's flags give way to the CRD provider's, read as the
# service account k8s/traefik/ binds to Traefik's ClusterRole.
TRAEFIK = "gateway-handler"
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
}
