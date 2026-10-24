#!/usr/bin/env python3
"""k3s's own ports answer localhost and the node, never the public address (hosting K13, OPS-1-o-l).

    k3s_ports.py apply      build the chain, hook it in on the public interface
    k3s_ports.py print      what `apply` would write, changing nothing
    k3s_ports.py remove     unhook and delete the chain (the ports open again)
    k3s_ports.py install    systemd units: once before k3s starts, then every 5 minutes

k3s listens on every address: the API server (6443), the kubelet (10250),
kube-proxy's health (10256), flannel (8472/udp VXLAN, 51820-51821/udp
WireGuard), and a NodePort for every LoadBalancer Service, which bypasses O7's
80/443 rules. All of it is dropped on EDGE_PUBLIC_IFACE (default: the default
route's interface), except from the other nodes listed in K3S_PEERS_FILE (one
address per line, K17); lo, cni0 and flannel's interfaces are never filtered,
so the node reaches its own ports on any of its addresses. 80/443 stay with
cloudflare_firewall.py (O7). Run `install` before k3s is installed (ADR-0163
point 3).
"""
import ipaddress
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from edge_chain import TOOL, hook_all, public_iface, run, unhook  # noqa: E402

CHAIN = "TXNET-K3S"
# K13: the API server, the kubelet, kube-proxy's healthz (0.0.0.0 by default).
NODE_TCP_PORTS = "6443,10250,10256"
# K13: flannel's VXLAN; K17: wireguard-native's IPv4 and IPv6 listeners.
NODE_UDP_PORTS = "8472,51820,51821"
# K17: the other nodes, the only sources let through to the ports above.
PEERS_FILE = os.environ.get("K3S_PEERS_FILE", "/etc/txnet/k3s-peers")
# k3s's default --service-node-port-range.
NODE_PORT_RANGE = "30000:32767"
UNIT_DIR = "/etc/systemd/system"
UNIT = "txnet-k3s-ports"
# k3s and kube-router insert their INPUT rules at the top; this puts ours back.
REASSERT_EVERY = "5min"

_SERVICE = """[Unit]
Description=Close k3s's own ports on the public interface (OPS-1-o-l, hosting K13)
# In place before k3s opens them, at every boot.
Before=k3s.service
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=/usr/bin/python3 {me} apply

[Install]
WantedBy=multi-user.target
"""
_TIMER = """[Unit]
Description=Keep k3s's ports closed above k3s's own rules

[Timer]
OnBootSec={every}
OnUnitActiveSec={every}

[Install]
WantedBy=timers.target
"""


def read_peers(path=PEERS_FILE):
    """The other nodes' addresses by IP family; `#` starts a comment. A missing
    file is a single-node cluster. A name is refused: iptables would resolve it
    once, and a later change of address would lock the node out silently."""
    peers = {4: [], 6: []}
    if not os.path.exists(path):
        return peers
    with open(path) as f:
        for line in f:
            word = line.split("#", 1)[0].strip()
            if word:
                address = ipaddress.ip_address(word)
                peers[address.version].append(str(address))
    return peers


def restore_payload(peers=()):
    """One atomic `iptables-restore --noflush` write that (re)declares the chain.
    The peers are let through, whatever else reaches it is dropped; the jumps
    choose what reaches it."""
    accept = [f"-A {CHAIN} -s {peer} -j ACCEPT" for peer in peers]
    return "\n".join(["*filter", f":{CHAIN} - [0:0]", *accept, f"-A {CHAIN} -j DROP", "COMMIT"]) + "\n"


def jump_rules(iface):
    """Where the public interface's traffic for k3s's ports enters the chain.
    The node's own listeners are reached in INPUT; a NodePort is DNATed to a
    pod first, so it is forwarded and matched on its original port."""
    rules = [
        ("INPUT", ["-i", iface, "-p", "tcp", "-m", "multiport", "--dports", NODE_TCP_PORTS, "-j", CHAIN]),
        ("INPUT", ["-i", iface, "-p", "udp", "-m", "multiport", "--dports", NODE_UDP_PORTS, "-j", CHAIN]),
    ]
    for proto in ("tcp", "udp"):
        rules.append(("FORWARD", ["-i", iface, "-p", proto, "-m", "conntrack", "--ctorigdstport", NODE_PORT_RANGE,
                                  "--ctdir", "ORIGINAL", "-j", CHAIN]))
    return rules


def apply(iface):
    peers = read_peers()
    for family, tool in TOOL.items():
        run(f"{tool}-restore", "--noflush", stdin=restore_payload(peers[family]))
        hook_all(tool, jump_rules(iface), CHAIN)
        print(f"{tool}: k3s's ports closed on {iface}, open to {peers[family] or 'no peer'}")


def remove(iface):
    for tool in TOOL.values():
        unhook(tool, jump_rules(iface), CHAIN)


def install():
    me = os.path.abspath(__file__)
    with open(os.path.join(UNIT_DIR, UNIT + ".service"), "w") as f:
        f.write(_SERVICE.format(me=me))
    with open(os.path.join(UNIT_DIR, UNIT + ".timer"), "w") as f:
        f.write(_TIMER.format(every=REASSERT_EVERY))
    subprocess.run(["systemctl", "daemon-reload"], check=True)
    subprocess.run(["systemctl", "enable", "--now", UNIT + ".service", UNIT + ".timer"], check=True)
    print(f"installed {UNIT}.service and {UNIT}.timer")


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ""
    if cmd == "install":
        return install()
    iface = public_iface()
    if cmd == "remove":
        return remove(iface)
    if cmd == "apply":
        return apply(iface)
    if cmd == "print":
        print(restore_payload(read_peers()[4]))
        for chain, args in jump_rules(iface):
            print(chain, " ".join(args))
        return None
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv) or 0)
