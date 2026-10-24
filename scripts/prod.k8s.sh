#!/usr/bin/env bash
# Production on Kubernetes (hosting K8, K10, ADR-0147).
#
#   scripts/prod.k8s.sh build              build every image compose builds, tagged for the registry
#   scripts/prod.k8s.sh push               push them: the node pulls, it never builds (K14)
#   scripts/prod.k8s.sh registries         on the node: write /etc/rancher/k3s/registries.yaml, the
#                                          registry's pull-only login from the sealed .env.prod (K14)
#   scripts/prod.k8s.sh render             the Kustomize bases into k8s/base/ and k8s/monitoring/base/,
#                                          from the sealed secrets opened in /dev/shm (K5); never committed
#   scripts/prod.k8s.sh deploy [overlay]   render, migrate, apply, wait on every rollout; a workload
#                                          that is not ready in 300s is rolled back and the deploy fails
#   scripts/prod.k8s.sh secrets init|list|seal [path...]|edit <path>
#                                          the sealed secrets (tools/k8s_secrets.py, contract.secrets.md)
#   scripts/prod.k8s.sh install-tools      sops and age-keygen at k8s/versions.env's pins, into /usr/local/bin
#
#   IMAGE_TAG     the release (default: the current commit)
#   HOST_GATEWAY  the node's address, which compose's `host-gateway` means (K3); render and deploy
#   KUBECTL       the kubectl to run (default: kubectl)
#   TOOLS_DIR     where install-tools puts sops and age-keygen (default: /usr/local/bin)
#   K3S_ETC       k3s's config directory; its presence marks the node (default: /etc/rancher/k3s)
#
# The compose files stay the only definition of a service; this renders them
# (tools/k8s_render.py: the main stack, and the monitoring one into
# txnet-monitoring, K11) and applies k8s/overlays/<overlay> (default: prod).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

IMAGE_TAG="${IMAGE_TAG:-$(git -C "$ROOT_DIR" rev-parse --short=12 HEAD)}"
KUBECTL="${KUBECTL:-kubectl}"
BASE="$ROOT_DIR/k8s/base"
MONITORING_BASE="$ROOT_DIR/k8s/monitoring/base"
NAMESPACE=txnet
ROLLOUT_TIMEOUT=300s # K10
JOB_POLL_S=5
# K10: what a release replaces, so what the last apply may prune. Never a
# PersistentVolumeClaim (its data), a Namespace, a CRD, or a Job (its log).
PRUNE_KINDS=(core/v1/ConfigMap core/v1/Secret core/v1/Service apps/v1/Deployment apps/v1/StatefulSet
  apps/v1/DaemonSet traefik.io/v1alpha1/IngressRoute traefik.io/v1alpha1/Middleware)
TRAEFIK_CRDS=(crd/ingressroutes.traefik.io crd/middlewares.traefik.io)
TOOLS_DIR="${TOOLS_DIR:-/usr/local/bin}"
K3S_ETC="${K3S_ETC:-/etc/rancher/k3s}"
# Every temporary path here holds secrets: removed however the script exits.
TEMPS=()
trap 'rm -rf "${TEMPS[@]}"' EXIT

die() {
  echo "prod.k8s.sh: $*" >&2
  exit 1
}

# The same project, env files and profile tools/k8s_render.py reads (K2).
compose() {
  ENVIRONMENT=prod docker compose -p txnet --env-file "$ROOT_DIR/.env" --env-file "$ROOT_DIR/.env.prod" \
    --profile migrate -f "$ROOT_DIR/dev-docker/docker-compose.main.yml" "$@"
}

# service <tab> local image <tab> registry image, one line per image compose builds.
images() {
  python3 "$ROOT_DIR/tools/k8s_render.py" --images --tag "$IMAGE_TAG"
}

# One service at a time: a parallel build starves whatever else runs on the host.
# Never on the node itself (K14): the 2026-10-23 restore's build starved its services.
build() {
  local service local_image remote
  [ ! -e "$K3S_ETC" ] || die "$K3S_ETC exists, so this is the k3s node: build off it and push (K14)"
  while IFS=$'\t' read -r service local_image remote; do
    echo "== build $service -> $remote"
    compose build "$service" </dev/null
    docker tag "$local_image" "$remote"
  done < <(images)
}

push() {
  local service local_image remote
  while IFS=$'\t' read -r service local_image remote; do
    echo "== push $service"
    docker push "$remote" </dev/null
  done < <(images)
}

# K5: the sealed secrets, opened into memory at $OPENED, which the caller
# removes as soon as it is done (and the exit trap does on failure). Not
# `$(open_sealed)`: a subshell's TEMPS would never reach the trap.
open_sealed() {
  OPENED="$(mktemp -d /dev/shm/txnet-secrets.XXXXXX)"
  TEMPS+=("$OPENED")
  python3 "$ROOT_DIR/tools/k8s_secrets.py" open "$OPENED"
}

render() {
  [ -n "${HOST_GATEWAY:-}" ] || die "HOST_GATEWAY=<node ip> is required (K3)"
  open_sealed
  python3 "$ROOT_DIR/tools/k8s_render.py" "$BASE" --tag "$IMAGE_TAG" --host-gateway "$HOST_GATEWAY" \
    --sealed "$OPENED"
  python3 "$ROOT_DIR/tools/k8s_render.py" "$MONITORING_BASE" --stack monitoring --tag "$IMAGE_TAG" \
    --sealed "$OPENED"
  rm -rf "$OPENED"
}

# K14: containerd reads registries.yaml when k3s starts, so it is written before
# k3s is installed (OPS-1-o-f), or k3s is restarted after. Owner-only: it holds the login.
registries() {
  local written
  open_sealed
  written="$(mktemp "$K3S_ETC/.registries.XXXXXX")" || die "no $K3S_ETC: make it, or run this on the node"
  TEMPS+=("$written")
  python3 "$ROOT_DIR/tools/k8s_render.py" --registries --sealed "$OPENED" >"$written"
  rm -rf "$OPENED"
  mv "$written" "$K3S_ETC/registries.yaml"
  echo "wrote $K3S_ETC/registries.yaml; if k3s is running, 'systemctl restart k3s' reads it"
}

# sops and age-keygen at their pins, each checked against its sha256 (K5).
install_tools() {
  local work
  # shellcheck source=../k8s/versions.env
  . "$ROOT_DIR/k8s/versions.env"
  work="$(mktemp -d)"
  TEMPS+=("$work")
  curl -fsSL -o "$work/sops" \
    "https://github.com/getsops/sops/releases/download/$SOPS_VERSION/sops-$SOPS_VERSION.linux.amd64"
  curl -fsSL -o "$work/age.tar.gz" \
    "https://github.com/FiloSottile/age/releases/download/$AGE_VERSION/age-$AGE_VERSION-linux-amd64.tar.gz"
  printf '%s  %s\n' "$SOPS_SHA256" "$work/sops" "$AGE_SHA256" "$work/age.tar.gz" | sha256sum -c --quiet ||
    die "a download does not match k8s/versions.env"
  tar -xzf "$work/age.tar.gz" -C "$work" age/age-keygen
  install -m 0755 "$work/sops" "$work/age/age-keygen" "$TOOLS_DIR/"
  echo "installed $("$TOOLS_DIR/sops" --version | head -1), age-keygen $("$TOOLS_DIR/age-keygen" --version)"
}

# Wait on each `namespace:kind/name`; undo every one that is not ready, then fail (K10).
roll_out() {
  local workload failed=()
  for workload in "$@"; do
    "$KUBECTL" -n "${workload%%:*}" rollout status "${workload#*:}" --timeout="$ROLLOUT_TIMEOUT" ||
      failed+=("$workload")
  done
  [ ${#failed[@]} -eq 0 ] && return 0
  for workload in "${failed[@]}"; do
    echo "== rollback $workload" >&2
    "$KUBECTL" -n "${workload%%:*}" rollout undo "${workload#*:}" || true
  done
  die "not ready in $ROLLOUT_TIMEOUT, rolled back: ${failed[*]}"
}

# db-migrate runs to completion before any Deployment is applied (K8). A Job's
# pod template cannot change, so the last run is deleted first.
migrate() {
  local state
  "$KUBECTL" -n "$NAMESPACE" delete job db-migrate --ignore-not-found --wait=true
  "$KUBECTL" apply -k "$BASE/jobs"
  while :; do
    state="$("$KUBECTL" -n "$NAMESPACE" get job db-migrate \
      -o jsonpath='{.status.conditions[?(@.status=="True")].type}')"
    case "$state" in
      *Complete*) return 0 ;;
      *Failed*)
        "$KUBECTL" -n "$NAMESPACE" logs job/db-migrate --tail=50 >&2 || true
        die "db-migrate failed; nothing was rolled out"
        ;;
    esac
    sleep "$JOB_POLL_S"
  done
}

deploy() {
  local overlay="$ROOT_DIR/k8s/overlays/${1:-prod}" manifest workloads kind allow=()
  [ -d "$overlay" ] || die "no overlay $overlay"
  render
  manifest="$(mktemp)" # holds Secrets: mktemp is 0600, and it is removed on exit
  TEMPS+=("$manifest")
  # An IngressRoute cannot be applied before its kind exists.
  "$KUBECTL" apply -k "$ROOT_DIR/k8s/traefik"
  "$KUBECTL" wait --for condition=established --timeout=60s "${TRAEFIK_CRDS[@]}"
  "$KUBECTL" kustomize "$overlay" >"$manifest"
  workloads="$(python3 "$ROOT_DIR/tools/k8s_manifest.py" workloads "$manifest")"
  python3 "$ROOT_DIR/tools/k8s_manifest.py" stores "$manifest" | "$KUBECTL" apply -f -
  # shellcheck disable=SC2046 # one workload per line, no spaces
  roll_out $(grep ':statefulset/' <<<"$workloads" || true)
  migrate
  "$KUBECTL" apply -f "$manifest"
  # shellcheck disable=SC2046
  roll_out $(grep -E ':(deployment|daemonset)/' <<<"$workloads" || true)
  # Pruned only now: a rollback above still finds the Secrets the old pods name.
  for kind in "${PRUNE_KINDS[@]}"; do allow+=("--prune-allowlist=$kind"); done
  "$KUBECTL" apply -f "$manifest" --prune -l app.kubernetes.io/part-of=txnet "${allow[@]}"
  echo "deployed $IMAGE_TAG"
}

case "${1:-}" in
  build) build ;;
  push) push ;;
  registries) registries ;;
  render) render ;;
  deploy) deploy "${2:-}" ;;
  secrets) shift && exec python3 "$ROOT_DIR/tools/k8s_secrets.py" "$@" ;;
  install-tools) install_tools ;;
  *) sed -n '2,20p' "$0" >&2 && exit 2 ;;
esac
