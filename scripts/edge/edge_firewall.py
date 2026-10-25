#!/usr/bin/env python3
"""Each door of the origin admits its own edges' published ranges, and nobody else.

ADR-0129 amendment 1, EDGE-1-h; a k3s host since OPS-1-o-g (hosting K9); the
domestic door since NIN-1-b2 (ADR-0165 point 3). Each door is one chain:

    origin-pull  80/443  Cloudflare, also held by O1's client certificate
    domestic     8443    the approved domestic edges (Arvan first), whose only proof is their ranges

An edge's row in edges.json names its door. Cloudflare never comes in on 8443:
nothing there checks a certificate, and Cloudflare proxies 8443 for any zone.

    edge_firewall.py apply      re-read every door's edges, rebuild each chain, hook it in
    edge_firewall.py print      what `apply` would write, changing nothing
    edge_firewall.py remove     unhook and delete every door's chain (ports open again)
    edge_firewall.py install    /etc/cron.d entry: at boot and daily

The ranges come through edge_ranges.py (O8): a list that is short, malformed or
failed to arrive is refused and the last good copy is used instead, since an
empty chain would drop every visitor; a door one of whose edges has no good
copy at all is left as it was. EDGE_PUBLIC_IFACE names the public interface
(default: the one the default route leaves by); bridges and the tunnel
interfaces are never filtered. Contract: docs/platform/hosting/contract.origin.md.
"""
import os
import sys
from dataclasses import dataclass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import edge_ranges  # noqa: E402
from edge_chain import TOOL, hook_all, public_iface, run, unhook  # noqa: E402


@dataclass(frozen=True)
class Door:
    name: str
    chain: str
    ports: tuple


# The ports are the gateways' published ones (dev-docker/compose/edge.yml).
DOORS = {door.name: door for door in (
    Door("origin-pull", "TXNET-EDGE", ("80", "443")),
    Door("domestic", "TXNET-DOMESTIC", ("8443",)),
)}
CRON = "/etc/cron.d/txnet-edge-firewall"
# The entry this script wrote as cloudflare_firewall.py, before NIN-1-b2.
FORMER_CRON = "/etc/cron.d/txnet-cloudflare-firewall"


def door_ranges(door, ranges=edge_ranges.ranges):
    """Every range of the door's edges, each edge re-read (O8); RangeError if one has no good copy."""
    merged = {4: [], 6: []}
    for edge in edge_ranges.load_edges().values():
        if edge["door"] != door.name:
            continue
        for family, cidrs in ranges(edge["name"]).items():
            merged[family] += cidrs
    return merged


def restore_payload(door, cidrs, iface):
    """One atomic `iptables-restore --noflush` write: the chain is redeclared
    (which empties it) and refilled in the same commit."""
    lines = ["*filter", f":{door.chain} - [0:0]", f"# the {door.name} door's edges for {iface}, from edges.json"]
    lines += [f"-A {door.chain} -s {cidr} -j RETURN" for cidr in cidrs]
    lines += [f"-A {door.chain} -j DROP", "COMMIT"]
    return "\n".join(lines) + "\n"


def jump_rules(door, iface):
    """Where traffic for the door's ports enters its chain. INPUT covers a
    gateway on the host's own sockets. A published port is DNATed before it is
    forwarded, so the forwarded rules match the original destination port:
    FORWARD for k3s's load balancer (servicelb's hostPort, K9), DOCKER-USER for
    Docker's, which Docker keeps ahead of its own FORWARD rules across restarts."""
    rules = [("INPUT", ["-i", iface, "-p", "tcp", "-m", "multiport", "--dports", ",".join(door.ports),
                        "-j", door.chain])]
    for chain in ("FORWARD", "DOCKER-USER"):
        for port in door.ports:
            rules.append((chain, ["-i", iface, "-p", "tcp", "-m", "conntrack", "--ctorigdstport", port,
                                  "--ctdir", "ORIGINAL", "-j", door.chain]))
    return rules


def apply(door, ranges, iface):
    for family, tool in TOOL.items():
        run(f"{tool}-restore", "--noflush", stdin=restore_payload(door, ranges[family], iface))
        hook_all(tool, jump_rules(door, iface), door.chain)
        print(f"{tool}: {len(ranges[family])} ranges admitted to the {door.name} door on {iface}:{','.join(door.ports)}")


def remove(iface):
    for door in DOORS.values():
        for tool in TOOL.values():
            unhook(tool, jump_rules(door, iface), door.chain)


def install():
    me = os.path.abspath(__file__)
    with open(CRON, "w") as f:
        f.write("# EDGE-1-h, NIN-1-b2: each door admits its own edges only, in step with their lists.\n"
                f"@reboot root sleep 90 && /usr/bin/python3 {me} apply\n"
                f"23 4 * * * root /usr/bin/python3 {me} apply\n")
    if os.path.exists(FORMER_CRON):
        os.remove(FORMER_CRON)
    print(f"wrote {CRON}")


def _show(door, ranges, iface):
    for family in TOOL:
        print(restore_payload(door, ranges[family], iface))
    for chain, args in jump_rules(door, iface):
        print(chain, " ".join(args))


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ""
    if cmd == "install":
        return install()
    iface = public_iface()
    if cmd == "remove":
        return remove(iface)
    if cmd not in ("apply", "print"):
        print(__doc__)
        return 2
    failed = 0
    for door in DOORS.values():
        try:
            ranges = door_ranges(door)
        except edge_ranges.RangeError as e:
            print(f"{door.name} door left as it was: {e}", file=sys.stderr)
            failed += 1
            continue
        (_show if cmd == "print" else apply)(door, ranges, iface)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv) or 0)
