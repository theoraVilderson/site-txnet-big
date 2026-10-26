#!/usr/bin/env bash
# A server joins the cluster as a k3s agent, or leaves it (hosting K17, OPS-1-o-q).
# Run as root on the k3s server node, from the checkout; the other server is
# reached over SSH as root, and nothing is copied to it but what k3s needs.
#
#   scripts/k8s-add-node.sh check  <host> [ssh-port]   what join would refuse, changing nothing
#   scripts/k8s-add-node.sh join   <host> [ssh-port]   check, then: its address in K13's peers here, K13's
#                                                      chain there with this node as its only peer, O7's
#                                                      edge chain there (80/443), k3s agent at
#                                                      k8s/versions.env's pin with this node's
#                                                      registries.yaml (K14), then Ready and on WireGuard
#   scripts/k8s-add-node.sh remove <host> [ssh-port]   drain and delete the node, uninstall k3s there,
#                                                      both chains gone and its address out of the peers
#
#   NODE_PRIVATE_IP    the other server's address on a private network shared with this one; then
#   SERVER_PRIVATE_IP  this one's: the API and flannel go over it (K17). Unset: the public addresses
#   SSH_KEY            the identity ssh uses (default: ssh's own)
#   MIN_NODE_MEM_MIB / MIN_NODE_DISK_GIB   lower floors for a trial node that will carry no release
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
K3S_ETC=/etc/rancher/k3s
PEERS_FILE=/etc/txnet/k3s-peers
NODE_TOKEN=/var/lib/rancher/k3s/server/node-token
# Where the node keeps the K13 scripts its systemd units run.
EDGE_DIR=/usr/local/lib/txnet/edge
STAGE=/root/.txnet-join
# K17: the stores' local-path volumes stay on the node that carries it (the render's DATA_NODE_LABEL).
DATA_LABEL=txnet.io/data=true
# Every approved edge's last good ranges (edge_ranges.py STATE_DIR, NIN-1-b1): the
# node starts from the server's, so a join never waits on an edge's list.
EDGE_RANGES=/var/lib/txnet/edge-ranges
EDGE_RANGES_CRON=/etc/cron.d/txnet-edge-ranges
EDGE_FIREWALL_CRON=/etc/cron.d/txnet-edge-firewall
# A worker must hold k3s, the OS and the largest single request (translator-llm,
# 2560 MiB in K19's report) with room to spare.
MIN_NODE_MEM_MIB="${MIN_NODE_MEM_MIB:-4096}"
# One release's images are ~17 GB on paper (2026-10-24, dev host), and K16
# keeps the release before beside it.
MIN_NODE_DISK_GIB="${MIN_NODE_DISK_GIB:-30}"
# Beyond this round trip a pod on one node querying a store on the other pays
# it per query (K17); the node is then a standby, not a worker.
MAX_WORKER_RTT_MS=10
# svclb binds these on every node for Traefik's LoadBalancer (K17); every edge
# shares them since NIN-1-b4.
LB_PORTS="80 443"
INOTIFY_INSTANCES=512 # as k8s-rehearse.sh's (K11)
NODE_REGISTER_TIMEOUT_S=120
NODE_READY_TIMEOUT=300s
TEMPS=()
trap 'rm -rf "${TEMPS[@]}"' EXIT

die() {
  echo "k8s-add-node.sh: $*" >&2
  exit 1
}

usage() {
  sed -n '2,18p' "$0" >&2
  exit 2
}

[ $# -ge 2 ] || usage
CMD="$1"
HOST="$2"
PORT="${3:-22}"
SSH=(ssh -p "$PORT" -o BatchMode=yes -o ConnectTimeout=15)
SCP=(scp -q -P "$PORT" -o BatchMode=yes)
if [ -n "${SSH_KEY:-}" ]; then
  SSH+=(-i "$SSH_KEY")
  SCP+=(-i "$SSH_KEY")
fi

remote() {
  "${SSH[@]}" "root@$HOST" "$@"
}

# The default route's source address on this node or, with `remote`, on the other.
route_src() {
  "$@" ip -4 route get 1.1.1.1 | sed -n 's/.* src \([0-9.]*\).*/\1/p'
}

require_server() {
  [ "$(id -u)" = 0 ] || die "run as root on the k3s server node"
  systemctl is-active -q k3s || die "k3s (the server) is not running here"
  [ -r "$NODE_TOKEN" ] || die "no $NODE_TOKEN: this is not the server node"
  grep -q '^flannel-backend: wireguard-native' "$K3S_ETC/config.yaml" ||
    die "flannel is not on WireGuard here: k8s/k3s/config.yaml's flannel-backend first (K17)"
}

SERVER_ADDR=""
NODE_ADDR=""
NODE_NAME=""

addresses() {
  SERVER_ADDR="${SERVER_PRIVATE_IP:-$(route_src)}"
  NODE_ADDR="${NODE_PRIVATE_IP:-$(route_src remote)}"
  NODE_NAME="$(remote hostname)"
  if [ -z "$SERVER_ADDR" ] || [ -z "$NODE_ADDR" ]; then die "could not tell the two addresses apart"; fi
  [ -z "${NODE_PRIVATE_IP:-}" ] || [ -n "${SERVER_PRIVATE_IP:-}" ] ||
    die "NODE_PRIVATE_IP needs SERVER_PRIVATE_IP: both ends of the private network"
}

# Everything join refuses, all of it reported before the first refusal counts.
check() {
  local failed=0 mem disk rtt held
  remote true || die "ssh root@$HOST -p $PORT does not answer"
  addresses
  echo "node $NODE_NAME at $NODE_ADDR, server at $SERVER_ADDR"
  if remote test -e /usr/local/bin/k3s; then
    echo "  REFUSED  k3s is already installed there"
    failed=1
  fi
  if remote "docker ps --format '{{.Names}}' 2>/dev/null" | grep -q '^txnet-dev-'; then
    echo "  REFUSED  the dev stack runs there: stop it first (ADR-0147 point 6)"
    failed=1
  fi
  mem="$(remote "awk '/MemTotal/ {print int(\$2/1024)}' /proc/meminfo")"
  if [ "$mem" -lt "$MIN_NODE_MEM_MIB" ]; then
    echo "  REFUSED  ${mem} MiB of memory, under ${MIN_NODE_MEM_MIB}"
    failed=1
  fi
  disk="$(remote "df -BG --output=avail /var/lib | tail -1 | tr -dc 0-9")"
  if [ "$disk" -lt "$MIN_NODE_DISK_GIB" ]; then
    echo "  REFUSED  ${disk} GiB free under /var/lib, under ${MIN_NODE_DISK_GIB}"
    failed=1
  fi
  if ! remote "modprobe -n wireguard" 2>/dev/null; then
    echo "  REFUSED  no wireguard kernel module (K17)"
    failed=1
  fi
  for port in $LB_PORTS; do
    held="$(remote "ss -Htlnp 'sport = :$port'" | sed -n 's/.*users:((\"\([^\"]*\)\".*/\1/p' | sort -u | tr '\n' ' ')"
    if [ -n "$held" ]; then
      echo "  REFUSED  port $port is held by ${held}— the cluster's LoadBalancer binds it there (K17)"
      failed=1
    fi
  done
  rtt="$(ping -c 5 -q "$NODE_ADDR" | sed -n 's|.*= [0-9.]*/\([0-9]*\).*|\1|p')"
  echo "  round trip ${rtt:-?} ms"
  if [ -n "$rtt" ] && [ "$rtt" -gt "$MAX_WORKER_RTT_MS" ]; then
    echo "  NOTE     over ${MAX_WORKER_RTT_MS} ms: a standby, not a worker (K17)"
  fi
  echo "  also listening there:"
  remote ss -Htulnp | awk '$5 !~ /^(127\.|\[::1\]|\[::ffff:127\.)/ {print "    " $1, $5, $7}' || true
  [ "$failed" = 0 ] || die "$HOST is refused"
  echo "  ok to join"
}

# This node's K13 chain lets the other one through, and only it.
peer_add() {
  install -d -m 0755 "$(dirname "$PEERS_FILE")"
  grep -qx "$1" "$PEERS_FILE" 2>/dev/null || echo "$1" >>"$PEERS_FILE"
  python3 "$ROOT_DIR/scripts/edge/k3s_ports.py" apply
}

peer_remove() {
  [ ! -e "$PEERS_FILE" ] || sed -i "/^$(printf '%s' "$1" | sed 's/\./\\./g')\$/d" "$PEERS_FILE"
  python3 "$ROOT_DIR/scripts/edge/k3s_ports.py" apply
}

# What the agent needs, in a 0700 directory: this node's binary checked against
# the pin, install.sh at the same tag, the token, registries.yaml, its config.
stage() {
  local work="$1" tag iface
  # shellcheck source=../k8s/versions.env
  . "$ROOT_DIR/k8s/versions.env"
  tag="${K3S_VERSION//+/%2B}"
  install -m 0755 /usr/local/bin/k3s "$work/k3s"
  curl -fsSL -o "$work/install.sh" "https://raw.githubusercontent.com/k3s-io/k3s/$tag/install.sh"
  printf '%s  %s\n' "$K3S_SHA256" "$work/k3s" "$K3S_INSTALL_SHA256" "$work/install.sh" | sha256sum -c --quiet ||
    die "this node's k3s or install.sh does not match k8s/versions.env"
  install -m 0600 "$NODE_TOKEN" "$work/token"
  install -m 0600 "$K3S_ETC/registries.yaml" "$work/registries.yaml"
  cp "$ROOT_DIR/scripts/edge/k3s_ports.py" "$ROOT_DIR/scripts/edge/edge_chain.py" \
    "$ROOT_DIR/scripts/edge/edge_firewall.py" "$ROOT_DIR/scripts/edge/edge_ranges.py" \
    "$ROOT_DIR/scripts/edge/edges.json" "$work/"
  [ ! -d "$EDGE_RANGES" ] || cp -r "$EDGE_RANGES" "$work/edge-ranges"
  echo "$SERVER_ADDR" >"$work/k3s-peers"
  {
    echo "# Written by scripts/k8s-add-node.sh (hosting K17)."
    echo "server: https://$SERVER_ADDR:6443"
    echo "token-file: $K3S_ETC/token"
    echo "node-ip: $NODE_ADDR"
    if [ -n "${NODE_PRIVATE_IP:-}" ]; then
      iface="$(remote ip -4 -o addr show | awk -v ip="$NODE_PRIVATE_IP" '$4 ~ "^"ip"/" {print $2}')"
      [ -n "$iface" ] || die "$NODE_PRIVATE_IP is on no interface of $HOST"
      echo "node-external-ip: $(route_src remote)"
      echo "flannel-iface: $iface"
    fi
  } >"$work/config.yaml"
  chmod 0600 "$work/config.yaml"
}

# On the other server: K13's chain and O7's before k3s opens a port, then the
# agent. svclb binds 80/443 on every node; the edges reach only the data
# node (K17), and O7's chain keeps anyone else off these. No proxy reaches k3s (K14), so
# install.sh writes none into the unit's env file.
install_agent() {
  remote "bash -s" <<EOF
set -euo pipefail
cd $STAGE
install -d -m 0755 $EDGE_DIR /etc/txnet
install -m 0644 k3s_ports.py edge_chain.py edge_firewall.py edge_ranges.py edges.json $EDGE_DIR/
install -m 0644 k3s-peers $PEERS_FILE
python3 $EDGE_DIR/k3s_ports.py install
[ ! -d edge-ranges ] || { install -d -m 0755 $EDGE_RANGES && install -m 0644 edge-ranges/*.json $EDGE_RANGES/; }
python3 $EDGE_DIR/edge_firewall.py apply
python3 $EDGE_DIR/edge_firewall.py install
python3 $EDGE_DIR/edge_ranges.py install
echo "fs.inotify.max_user_instances=$INOTIFY_INSTANCES" >/etc/sysctl.d/90-txnet-k3s.conf
sysctl -q -p /etc/sysctl.d/90-txnet-k3s.conf
install -d -m 0700 $K3S_ETC
install -m 0600 token registries.yaml config.yaml $K3S_ETC/
install -m 0755 k3s /usr/local/bin/k3s
env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY -u no_proxy -u NO_PROXY \
  INSTALL_K3S_SKIP_DOWNLOAD=true INSTALL_K3S_VERSION='$K3S_VERSION' INSTALL_K3S_EXEC=agent \
  K3S_URL='https://$SERVER_ADDR:6443' K3S_TOKEN_FILE=$K3S_ETC/token sh install.sh
cd / && rm -rf $STAGE
EOF
}

wait_ready() {
  timeout "$NODE_REGISTER_TIMEOUT_S" sh -c "until kubectl get node '$NODE_NAME' -o name >/dev/null 2>&1; do sleep 2; done" ||
    die "$NODE_NAME did not register in ${NODE_REGISTER_TIMEOUT_S}s: journalctl -u k3s-agent there"
  kubectl wait --for=condition=Ready "node/$NODE_NAME" --timeout="$NODE_READY_TIMEOUT"
  remote ip link show flannel-wg >/dev/null || die "$NODE_NAME is Ready but has no flannel-wg (K17)"
}

join() {
  local work
  require_server
  check
  work="$(mktemp -d)"
  TEMPS+=("$work")
  stage "$work"
  peer_add "$NODE_ADDR"
  remote "rm -rf $STAGE && install -d -m 0700 $STAGE"
  "${SCP[@]}" "$work"/* "root@$HOST:$STAGE/"
  install_agent
  wait_ready
  kubectl label --overwrite "node/$(hostname)" "$DATA_LABEL" >/dev/null
  echo "$NODE_NAME joined over WireGuard; the stores stay on $(hostname) ($DATA_LABEL)"
  kubectl get nodes -o wide
}

remove() {
  require_server
  addresses
  if kubectl get node "$NODE_NAME" >/dev/null 2>&1; then
    kubectl drain "$NODE_NAME" --ignore-daemonsets --delete-emptydir-data --timeout="$NODE_READY_TIMEOUT"
    kubectl delete node "$NODE_NAME"
  fi
  remote "bash -s" <<EOF
set -euo pipefail
[ ! -x /usr/local/bin/k3s-agent-uninstall.sh ] || /usr/local/bin/k3s-agent-uninstall.sh
systemctl disable --now txnet-k3s-ports.timer txnet-k3s-ports.service 2>/dev/null || true
rm -f /etc/systemd/system/txnet-k3s-ports.service /etc/systemd/system/txnet-k3s-ports.timer
systemctl daemon-reload
[ ! -e $EDGE_DIR/k3s_ports.py ] || python3 $EDGE_DIR/k3s_ports.py remove
[ ! -e $EDGE_DIR/edge_firewall.py ] || python3 $EDGE_DIR/edge_firewall.py remove
# A node joined before NIN-1-b2 runs the script under its former name.
[ ! -e $EDGE_DIR/cloudflare_firewall.py ] || python3 $EDGE_DIR/cloudflare_firewall.py remove
rm -rf $EDGE_DIR $PEERS_FILE $EDGE_RANGES $EDGE_RANGES_CRON $EDGE_FIREWALL_CRON /etc/cron.d/txnet-cloudflare-firewall \
  /var/lib/txnet/cloudflare-ips.json /etc/sysctl.d/90-txnet-k3s.conf
EOF
  peer_remove "$NODE_ADDR"
  echo "$NODE_NAME has left the cluster"
}

case "$CMD" in
  check) check ;;
  join) join ;;
  remove) remove ;;
  *) usage ;;
esac
