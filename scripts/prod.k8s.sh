#!/usr/bin/env bash
# Production on Kubernetes (hosting K8, K10, K16, ADR-0147, ADR-0164).
#
#   scripts/prod.k8s.sh build              build each image compose builds whose source's tag the registry lacks (K8)
#   scripts/prod.k8s.sh push               push them: the node pulls, it never builds (K14); a registry
#                                          that does not answer is named before the first image
#   scripts/prod.k8s.sh registries         on the node: write /etc/rancher/k3s/registries.yaml, the
#                                          registry's pull-only login from the sealed .env.prod (K14)
#   scripts/prod.k8s.sh render             the Kustomize bases into k8s/base/ and k8s/monitoring/base/,
#                                          from the sealed secrets opened in /dev/shm (K5); never committed
#   scripts/prod.k8s.sh deploy [overlay]   render, migrate, apply, wait on every rollout, smoke check; a
#                                          workload not ready in 300s or a failed check sets every workload
#                                          back to the release before, and the deploy fails (K16)
#   scripts/prod.k8s.sh rollback [tag]     by hand: every workload back to `tag` (default: the release
#                                          before the one running), rendered from that commit
#   scripts/prod.k8s.sh smoke [overlay]    the smoke check alone: each container's probe, each IngressRoute
#   scripts/prod.k8s.sh secrets init|list|seal [path...]|edit <path>
#                                          the sealed secrets (tools/k8s_secrets.py, contract.secrets.md)
#   scripts/prod.k8s.sh install-tools      sops and age-keygen at k8s/versions.env's pins, into /usr/local/bin
#
#   IMAGE_TAG     the release: the current commit, which deploy requires it to be (K16)
#   HOST_GATEWAY  the node's address, which compose's `host-gateway` means (K3); render and deploy
#   KUBECTL       the kubectl to run (default: kubectl)
#   TOOLS_DIR     where install-tools puts sops and age-keygen (default: /usr/local/bin)
#   K3S_ETC       k3s's config directory; its presence marks the node (default: /etc/rancher/k3s)
#   NODE_NAME     this host's k3s node name, read for its taint before a build on an agent (default: hostname)
#
# The compose files stay the only definition of a service; this renders them
# (tools/k8s_render.py: the main stack, and the monitoring one into
# txnet-monitoring, K11) and applies k8s/overlays/<overlay> (default: prod).
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

IMAGE_TAG="${IMAGE_TAG:-$(git -C "$ROOT_DIR" rev-parse --short=12 HEAD)}"
KUBECTL="${KUBECTL:-kubectl}"
NAMESPACE=txnet
ROLLOUT_TIMEOUT=300s # K10
JOB_POLL_S=5
REGISTRY_TIMEOUT_S=15 # K14: one /v2/ request, before a push or after writing registries.yaml
# K10: what a release replaces, so what the last apply may prune. Never a
# PersistentVolumeClaim (its data), a Namespace, a CRD, or a Job (its log).
PRUNE_KINDS=(core/v1/ConfigMap core/v1/Secret core/v1/Service apps/v1/Deployment apps/v1/StatefulSet
  apps/v1/DaemonSet traefik.io/v1alpha1/IngressRoute traefik.io/v1alpha1/Middleware)
TRAEFIK_CRDS=(crd/ingressroutes.traefik.io crd/middlewares.traefik.io)
RELEASE_RECORD=txnet-release # K16: ConfigMap {history, overlay}
# K17: the node every pod holding a claim or a host path is pinned to (the render's DATA_NODE_LABEL).
DATA_LABEL=txnet.io/data=true
ROLLOUT_FAILED=()
TOOLS_DIR="${TOOLS_DIR:-/usr/local/bin}"
K3S_ETC="${K3S_ETC:-/etc/rancher/k3s}"
# K14: an agent with this taint carries no release pod, so it may build.
NO_RELEASE_TAINT=txnet.io/no-release=true:NoSchedule
KUBELET_KUBECONFIG=/var/lib/rancher/k3s/agent/kubelet.kubeconfig
NODE_NAME="${NODE_NAME:-$(hostname)}"
# Every temporary path here holds secrets: removed however the script exits.
TEMPS=()
# A rollback's worktree is one of them; `worktree prune` then forgets it.
trap 'rm -rf "${TEMPS[@]}"; git -C "$ROOT_DIR" worktree prune' EXIT

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

# K14: never where the release runs — the 2026-10-23 restore's build starved its
# services. The server node always runs it; an agent may build only while it
# carries NO_RELEASE_TAINT, which keeps every release pod off it (user 2026-10-24).
require_build_host() {
  [ -e "$K3S_ETC" ] || return 0
  [ ! -e "$K3S_ETC/k3s.yaml" ] || die "this is the k3s server node, where the release runs: build off it and push (K14)"
  local taints
  taints="$(k3s kubectl --kubeconfig "$KUBELET_KUBECONFIG" get node "$NODE_NAME" \
    -o jsonpath='{.spec.taints[*].key}' 2>/dev/null)" || true
  [[ " $taints " == *" ${NO_RELEASE_TAINT%%=*} "* ]] ||
    die "this k3s agent has no ${NO_RELEASE_TAINT%%=*} taint, so release pods may run here (K14)"
}

# K8 (OPS-1-o-y): a tag is its source's fingerprint, so a tag the registry holds is built.
in_registry() {
  docker manifest inspect "$1" >/dev/null 2>&1
}

# A tag fingerprints HEAD's source: built from uncommitted files, an image would
# carry a tag that names something else.
require_clean() {
  [ -z "$(git -C "$ROOT_DIR" status --porcelain)" ] ||
    die "the checkout has uncommitted changes: an image is tagged by HEAD's source, not the files on disk (K8)"
}

# One service at a time: a parallel build starves whatever else runs on the host.
build() {
  local service local_image remote
  require_build_host
  require_clean
  while IFS=$'\t' read -r service local_image remote; do
    if in_registry "$remote" </dev/null; then
      echo "== in registry $service ($remote)"
      continue
    fi
    echo "== build $service -> $remote"
    compose build "$service" </dev/null
    docker tag "$local_image" "$remote"
  done < <(images)
}

# K14 (OPS-1-o-t): the registry's /v2/ answers 200, or 401 asking for the login.
# Anything else — 503/504 from a proxy in front of it, or no answer — fails here,
# naming the registry, before a release's worth of layers is sent into it.
require_registry() {
  local status
  status="$(curl --noproxy '*' -s -o /dev/null -m "$REGISTRY_TIMEOUT_S" -w '%{http_code}' "https://$1/v2/")" ||
    true
  case "$status" in
    200 | 401) ;;
    *) die "registry $1 does not answer (HTTP ${status:-000} on /v2/): $2 (K14)" ;;
  esac
}

push() {
  local service local_image remote listed first
  listed="$(images)"
  first="${listed%%$'\n'*}"
  first="${first##*$'\t'}"
  require_registry "${first%%/*}" "nothing was pushed"
  while IFS=$'\t' read -r service local_image remote; do
    ! in_registry "$remote" </dev/null || continue
    echo "== push $service"
    docker push "$remote" </dev/null
  done <<<"$listed"
}

# K5: the sealed secrets, opened into memory at $OPENED, which the caller
# removes as soon as it is done (and the exit trap does on failure). Not
# `$(open_sealed)`: a subshell's TEMPS would never reach the trap.
open_sealed() {
  OPENED="$(mktemp -d /dev/shm/txnet-secrets.XXXXXX)"
  TEMPS+=("$OPENED")
  python3 "$ROOT_DIR/tools/k8s_secrets.py" open "$OPENED"
}

# `tree`'s two stacks rendered into its own k8s/base and k8s/monitoring/base,
# from the sealed secrets opened at $OPENED (K5). `tree` is the checkout, or a
# rollback's worktree of an earlier commit (K16).
render_tree() {
  [ -n "${HOST_GATEWAY:-}" ] || die "HOST_GATEWAY=<node ip> is required (K3)"
  python3 "$1/tools/k8s_render.py" "$1/k8s/base" --tag "$2" --host-gateway "$HOST_GATEWAY" --sealed "$OPENED"
  python3 "$1/tools/k8s_render.py" "$1/k8s/monitoring/base" --stack monitoring --tag "$2" --sealed "$OPENED"
}

render() {
  open_sealed
  render_tree "$ROOT_DIR" "$IMAGE_TAG"
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
  # From the node itself: on 2026-10-24 the test server met 503/504 where the dev host met 401 (OPS-1-o-t).
  require_registry "$(python3 -c 'import sys, yaml; print(next(iter(yaml.safe_load(open(sys.argv[1]))["configs"])))' \
    "$K3S_ETC/registries.yaml")" "the file is written, but no pod of ours will pull"
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

# Wait on each `namespace:kind/name`; the ones not ready in time go to
# ROLLOUT_FAILED. Never fails itself: called inside `||` or `if`, a function
# runs with `set -e` off, so the caller reads the array instead.
roll_out() {
  local workload
  for workload in "$@"; do
    "$KUBECTL" -n "${workload%%:*}" rollout status "${workload#*:}" --timeout="$ROLLOUT_TIMEOUT" ||
      ROLLOUT_FAILED+=("$workload")
  done
}

# K10, for the first release only: with no earlier one to go back to, each
# workload that failed is undone on its own.
undo_each() {
  local workload
  for workload in "$@"; do
    echo "== rollback $workload" >&2
    "$KUBECTL" -n "${workload%%:*}" rollout undo "${workload#*:}" || true
  done
}

# db-migrate runs to completion before any Deployment is applied (K8). A Job's
# pod template cannot change, so the last run is deleted first.
migrate() {
  local state
  "$KUBECTL" -n "$NAMESPACE" delete job db-migrate --ignore-not-found --wait=true
  "$KUBECTL" apply -k "$1/k8s/base/jobs"
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

# OPS-1-o-w: the RLS login roles every service connects as, with the passwords in
# the opened env files. After db-migrate, which makes the group roles they join;
# on a rollback too, so a password rotated since stays rotated (R7). Idempotent.
login_roles() {
  ENV_DIR="$OPENED" ENV_FILE=.env.prod DB_EXEC="$KUBECTL -n $NAMESPACE exec -i statefulset/main-db -c main-db --" \
    "$ROOT_DIR/scripts/db-login-roles.sh"
}

# `tree`'s rendered bases through `overlay`, into MANIFEST (0600: it holds Secrets).
build_manifest() {
  local overlay="$1/k8s/overlays/$2"
  [ -d "$overlay" ] || die "no overlay $overlay"
  MANIFEST="$(mktemp)"
  TEMPS+=("$MANIFEST")
  "$KUBECTL" kustomize "$overlay" >"$MANIFEST"
}

# K10's order for `tree`: Traefik's CRDs, the stores, db-migrate unless $2 is
# `no` (K16: a rollback never undoes it), the login roles, then the workloads. Stops at the
# first set with a workload in ROLLOUT_FAILED.
apply_release() {
  local workloads
  ROLLOUT_FAILED=()
  # On an empty cluster Traefik's ServiceAccount and the stores' claims name
  # these namespaces before the manifest that also holds them is applied.
  "$KUBECTL" apply -f "$1/k8s/base/namespace.yaml" -f "$1/k8s/monitoring/base/namespace.yaml"
  # An IngressRoute cannot be applied before its kind exists.
  "$KUBECTL" apply -k "$1/k8s/traefik"
  "$KUBECTL" wait --for condition=established --timeout=60s "${TRAEFIK_CRDS[@]}"
  workloads="$(python3 "$ROOT_DIR/tools/k8s_manifest.py" workloads "$MANIFEST")"
  python3 "$ROOT_DIR/tools/k8s_manifest.py" stores "$MANIFEST" | "$KUBECTL" apply -f -
  # shellcheck disable=SC2046 # one workload per line, no spaces
  roll_out $(grep ':statefulset/' <<<"$workloads" || true)
  [ ${#ROLLOUT_FAILED[@]} -eq 0 ] || return 0
  [ "$2" = no ] || migrate "$1"
  login_roles
  "$KUBECTL" apply -f "$MANIFEST"
  # shellcheck disable=SC2046
  roll_out $(grep -E ':(deployment|daemonset)/' <<<"$workloads" || true)
}

# K16: every container's probe and one request per IngressRoute, through Traefik
# with the origin-pull client pair (tools/k8s_release.py).
smoke_check() {
  python3 "$ROOT_DIR/tools/k8s_release.py" smoke "$MANIFEST" --sealed "$OPENED" --kubectl "$KUBECTL"
}

# Only after the release is ready and passed its smoke check: until then the
# Secrets the previous release's pods name must still exist (K10).
prune() {
  local kind allow=()
  for kind in "${PRUNE_KINDS[@]}"; do allow+=("--prune-allowlist=$kind"); done
  "$KUBECTL" apply -f "$MANIFEST" --prune -l app.kubernetes.io/part-of=txnet "${allow[@]}"
}

# K16: the record is one ConfigMap, outside the release's label, so no prune removes it.
release_field() {
  "$KUBECTL" -n "$NAMESPACE" get configmap "$RELEASE_RECORD" -o jsonpath="{.data.$1}" 2>/dev/null || true
}

record_release() { # deploy|rollback <tag> <overlay>
  local history
  # shellcheck disable=SC2046 # the history is space-separated commits
  history="$(python3 "$ROOT_DIR/tools/k8s_release.py" history "$1" "$2" $(release_field history))"
  "$KUBECTL" -n "$NAMESPACE" create configmap "$RELEASE_RECORD" --from-literal=history="$history" \
    --from-literal=overlay="$3" --dry-run=client -o yaml | "$KUBECTL" apply -f -
}

# K16: a release is a commit. The tag names it, and a rollback renders that
# commit again, so what is deployed must be exactly what was committed.
# K17: unlabelled, every store waits Pending; mislabelled, a first claim binds
# on a node it can never leave. So no node with the label, nothing applied.
require_data_node() {
  [ -n "$("$KUBECTL" get nodes -l "$DATA_LABEL" -o name)" ] ||
    die "no node is labelled $DATA_LABEL: label the server node first (K17)"
}

require_commit() {
  [ "$IMAGE_TAG" = "$(git -C "$ROOT_DIR" rev-parse --short=12 HEAD)" ] ||
    die "IMAGE_TAG $IMAGE_TAG is not HEAD: a release is the commit checked out (K16)"
  [ -z "$(git -C "$ROOT_DIR" status --porcelain)" ] ||
    die "the checkout has uncommitted changes: a rollback to $IMAGE_TAG could not render them (K16)"
}

# K16: every workload back to `tag`, rendered from that commit in a worktree,
# with today's sealed secrets (a rotated password stays rotated) and no db-migrate.
go_back() {
  local tag="$1" tree
  git -C "$ROOT_DIR" rev-parse --verify --quiet "$tag^{commit}" >/dev/null || die "$tag is not a commit here (K16)"
  tree="$(mktemp -d)"
  TEMPS+=("$tree")
  git -C "$ROOT_DIR" worktree add --quiet --detach "$tree" "$tag"
  render_tree "$tree" "$tag"
  build_manifest "$tree" "$2"
  apply_release "$tree" no
  [ ${#ROLLOUT_FAILED[@]} -eq 0 ] || die "the rollback to $tag is not ready either: ${ROLLOUT_FAILED[*]}"
  smoke_check || die "the rollback to $tag fails its smoke check too"
  prune
  record_release rollback "$tag" "$2"
}

deploy() {
  local overlay="${1:-prod}" from reason
  require_commit
  require_data_node
  # shellcheck disable=SC2046
  from="$(python3 "$ROOT_DIR/tools/k8s_release.py" current $(release_field history))"
  open_sealed
  render_tree "$ROOT_DIR" "$IMAGE_TAG"
  build_manifest "$ROOT_DIR" "$overlay"
  apply_release "$ROOT_DIR" yes
  if [ ${#ROLLOUT_FAILED[@]} -eq 0 ]; then
    if smoke_check; then
      prune
      record_release deploy "$IMAGE_TAG" "$overlay"
      echo "deployed $IMAGE_TAG"
      return 0
    fi
    reason="failed its smoke check"
  else
    reason="was not ready in $ROLLOUT_TIMEOUT: ${ROLLOUT_FAILED[*]}"
  fi
  if [ -z "$from" ]; then
    undo_each "${ROLLOUT_FAILED[@]}"
    die "$IMAGE_TAG $reason; no earlier release to go back to (K10)"
  fi
  echo "== $IMAGE_TAG $reason: every workload back to $from (K16)" >&2
  go_back "$from" "$overlay"
  die "$IMAGE_TAG $reason; rolled back to $from"
}

# By hand (K16): back to `tag`, or to the release before the one running.
rollback() {
  local tag="${1:-}"
  # shellcheck disable=SC2046
  [ -n "$tag" ] || tag="$(python3 "$ROOT_DIR/tools/k8s_release.py" previous $(release_field history))"
  [ -n "$tag" ] || die "no earlier release is recorded in configmap/$RELEASE_RECORD (K16)"
  require_data_node
  open_sealed
  go_back "$tag" "$(release_field overlay)"
  echo "rolled back to $tag"
}

# By hand: the smoke check against what HEAD renders (K16).
smoke() {
  open_sealed
  render_tree "$ROOT_DIR" "$IMAGE_TAG"
  build_manifest "$ROOT_DIR" "${1:-prod}"
  smoke_check
}

# Sourced by tools/k8s_release_test.py, which drives deploy and rollback with a fake kubectl.
[ "${BASH_SOURCE[0]}" = "$0" ] || return 0

case "${1:-}" in
  build) build ;;
  push) push ;;
  registries) registries ;;
  render) render ;;
  deploy) deploy "${2:-}" ;;
  smoke) smoke "${2:-}" ;;
  rollback) rollback "${2:-}" ;;
  secrets) shift && exec python3 "$ROOT_DIR/tools/k8s_secrets.py" "$@" ;;
  install-tools) install_tools ;;
  *) sed -n '2,26p' "$0" >&2 && exit 2 ;;
esac
