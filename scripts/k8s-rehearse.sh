#!/usr/bin/env bash
# The rehearsal on the test server (hosting K12, ADR-0163, OPS-1-o-f): real k3s on
# the host, beside Docker, with the compose stack stopped. Run as root on the
# node, from the checkout, with the user (ADR-0163 point 3).
#
#   scripts/k8s-rehearse.sh up       K13's chain installed, the compose stack stopped, the node's
#                                    sysctl, k3s's config and registries.yaml, then k3s itself at
#                                    k8s/versions.env's pin (K1), each download checked
#   scripts/k8s-rehearse.sh deploy   prod.k8s.sh deploy with overlay `rehearsal` (no ACME)
#   scripts/k8s-rehearse.sh check    tools/k8s_rehearse.py check: every workload ready, a roll under
#                                    load with no failed request, the stores killed and back, the
#                                    drill, a bundle restored
#   scripts/k8s-rehearse.sh down     only when the rehearsal is abandoned: k3s uninstalled, K13's
#                                    chain removed, the compose stack back. The cluster that passes
#                                    is the one OPS-1-p cuts over to (ADR-0163 point 6)
#
#   HOST_GATEWAY  the node's public address (default: the default route's source address)
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
K3S_ETC=/etc/rancher/k3s
BIN_DIR=/usr/local/bin
# K11: at 128 Promtail exited "too many open files" (contract.kubernetes.md).
SYSCTL_FILE=/etc/sysctl.d/90-txnet-k3s.conf
INOTIFY_INSTANCES=512
NODE_READY_TIMEOUT=300s
NODE_REGISTER_TIMEOUT_S=120
TEMPS=()
trap 'rm -rf "${TEMPS[@]}"' EXIT

die() {
  echo "k8s-rehearse.sh: $*" >&2
  exit 1
}

HOST_GATEWAY="${HOST_GATEWAY:-$(ip -4 route get 1.1.1.1 | sed -n 's/.* src \([0-9.]*\).*/\1/p')}"
export HOST_GATEWAY

# ADR-0147 point 6: never on the dev host, which runs the live site and bot.
require_node() {
  [ "$(id -u)" = 0 ] || die "run as root on the node"
  if docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^txnet-dev-'; then
    die "the dev stack runs here: k3s is never installed on the dev host (ADR-0147 point 6)"
  fi
}

# K13: the chain is in place, and kept so by its timer, before k3s opens a port;
# O7's too, since svclb binds 80/443 here (K9). `down` keeps O7: compose's host has it.
close_ports() {
  python3 "$ROOT_DIR/scripts/edge/k3s_ports.py" install
  iptables -S TXNET-K3S >/dev/null 2>&1 || die "chain TXNET-K3S is not there after install (K13)"
  python3 "$ROOT_DIR/scripts/edge/cloudflare_firewall.py" apply
  python3 "$ROOT_DIR/scripts/edge/cloudflare_firewall.py" install
  python3 "$ROOT_DIR/scripts/edge/edge_ranges.py" install
}

# prod.compose.sh's project. `stop`, not `down`: its containers and volumes stay
# for `down` below to bring back.
stop_compose() {
  local running
  running="$(docker ps -q --filter label=com.docker.compose.project=prodtxnet)"
  [ -z "$running" ] || "$ROOT_DIR/scripts/prod.compose.sh" stop
}

node_sysctl() {
  echo "fs.inotify.max_user_instances=$INOTIFY_INSTANCES" >"$SYSCTL_FILE"
  sysctl -q -p "$SYSCTL_FILE"
}

# The binary at K3S_VERSION, then install.sh at the same tag with the download
# skipped: it writes the unit, kubectl/crictl links and k3s-uninstall.sh.
install_k3s() {
  local work tag
  # shellcheck source=../k8s/versions.env
  . "$ROOT_DIR/k8s/versions.env"
  tag="${K3S_VERSION//+/%2B}"
  work="$(mktemp -d)"
  TEMPS+=("$work")
  curl -fsSL -o "$work/k3s" "https://github.com/k3s-io/k3s/releases/download/$tag/k3s"
  curl -fsSL -o "$work/install.sh" "https://raw.githubusercontent.com/k3s-io/k3s/$tag/install.sh"
  printf '%s  %s\n' "$K3S_SHA256" "$work/k3s" "$K3S_INSTALL_SHA256" "$work/install.sh" | sha256sum -c --quiet ||
    die "a download does not match k8s/versions.env"
  install -m 0755 "$work/k3s" "$BIN_DIR/k3s"
  # No proxy reaches k3s: registries.yaml's mirror and our registry are reached directly (K14).
  env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY \
    INSTALL_K3S_SKIP_DOWNLOAD=true INSTALL_K3S_VERSION="$K3S_VERSION" sh "$work/install.sh"
  # `wait` finds nothing until the node has registered, and fails at once then.
  timeout "$NODE_REGISTER_TIMEOUT_S" sh -c 'until kubectl get node -o name 2>/dev/null | grep -q .; do sleep 2; done' ||
    die "the node did not register in ${NODE_REGISTER_TIMEOUT_S}s"
  kubectl wait --for=condition=Ready node --all --timeout="$NODE_READY_TIMEOUT"
  k3s secrets-encrypt status | grep -q 'Encryption Status: Enabled' ||
    die "k3s runs without secrets-encryption (S6)"
}

up() {
  require_node
  [ ! -e "$BIN_DIR/k3s" ] || die "k3s is already installed; 'down' first to start over"
  close_ports
  stop_compose
  node_sysctl
  install -d -m 0700 "$K3S_ETC"
  install -m 0600 "$ROOT_DIR/k8s/k3s/config.yaml" "$K3S_ETC/config.yaml"
  # K14: containerd reads it when k3s starts, so before the install.
  "$ROOT_DIR/scripts/prod.k8s.sh" registries
  install_k3s
  echo "k3s $(k3s --version | head -1 | cut -d' ' -f3) is up on $HOST_GATEWAY"
}

deploy() {
  require_node
  "$ROOT_DIR/scripts/prod.k8s.sh" deploy rehearsal
}

check() {
  require_node
  python3 "$ROOT_DIR/tools/k8s_rehearse.py" check --address "$HOST_GATEWAY"
}

down() {
  require_node
  [ ! -x "$BIN_DIR/k3s-uninstall.sh" ] || "$BIN_DIR/k3s-uninstall.sh"
  systemctl disable --now txnet-k3s-ports.timer txnet-k3s-ports.service 2>/dev/null || true
  rm -f /etc/systemd/system/txnet-k3s-ports.{service,timer}
  systemctl daemon-reload
  python3 "$ROOT_DIR/scripts/edge/k3s_ports.py" remove
  rm -f "$SYSCTL_FILE"
  "$ROOT_DIR/scripts/prod.compose.sh" up -d
}

case "${1:-}" in
  up) up ;;
  deploy) deploy ;;
  check) check ;;
  down) down ;;
  *) sed -n '2,17p' "$0" >&2 && exit 2 ;;
esac
