# Traefik with its file config, local plugins and origin-pull CA inside the
# image (hosting K8, K9): on Kubernetes nothing is bind-mounted from a checkout.
# Compose still mounts the same three directories over these in dev, so an
# edit there is live without a rebuild.
ARG DOCKER_REGISTRY
FROM ${DOCKER_REGISTRY}/traefik:v3.7

COPY dynamic/ /etc/traefik/dynamic/
COPY plugins-local/ /plugins-local/
COPY origin-pull/ /etc/traefik/origin-pull/
