#!/usr/bin/env python3
"""The origin's 80/443 admit the approved edges' published ranges, and nobody else.

ADR-0129 amendment 1, EDGE-1-h; a k3s host since OPS-1-o-g (hosting K9); one
door for every edge since NIN-1-b4 (ADR-0165 amendment 2). One chain,
TXNET-EDGE, admits every edge in edges.json to 80/443. Past the firewall each
edge proves itself its own way (O7): Cloudflare by O1's client certificate,
a domestic edge (Arvan first) by these same ranges, which the gateway reads
from the copies edge_ranges.py keeps.

    edge_firewall.py apply      re-read every edge, rebuild the chain, hook it in
    edge_firewall.py print      what `apply` would write, changing nothing
    edge_firewall.py remove     unhook and delete the chain (ports open again)
    edge_firewall.py install    /etc/cron.d entry: at boot and daily

The ranges come through edge_ranges.py (O8): a list that is short, malformed or
failed to arrive is refused and the last good copy is used instead, since an
empty chain would drop every visitor; with an edge that has no good copy at
all, the chain is left as it was. EDGE_PUBLIC_IFACE names the public interface
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


# The gateway's published ports (dev-docker/compose/edge.yml).
DOOR = Door("edge", "TXNET-EDGE", ("80", "443"))
# The domestic door's own chain on 8443 (NIN-1-b2), before NIN-1-b4 folded it
# into DOOR: every apply unhooks it where a node still has it.
FORMER_DOORS = (Door("domestic", "TXNET-DOMESTIC", ("8443",)),)
CRON = "/etc/cron.d/txnet-edge-firewall"
# The entry this script wrote as cloudflare_firewall.py, before NIN-1-b2.
FORMER_CRON = "/etc/cron.d/txnet-cloudflare-firewall"


def all_ranges(ranges=edge_ranges.ranges):
    """Every edge's ranges, each re-read (O8); RangeError if one has no good copy."""
    merged = {4: [], 6: []}
    for name in edge_ranges.load_edges():
        for family, cidrs in ranges(name).items():
            merged[family] += cidrs
    return merged


def restore_payload(door, cidrs, iface):
    """One atomic `iptables-restore --noflush` write: the chain is redeclared
    (which empties it) and refilled in the same commit."""
    lines = ["*filter", f":{door.chain} - [0:0]", f"# every edge for {iface}, from edges.json"]
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
        print(f"{tool}: {len(ranges[family])} ranges admitted on {iface}:{','.join(door.ports)}")
    remove_former(iface)


def remove_former(iface):
    for door in FORMER_DOORS:
        for tool in TOOL.values():
            unhook(tool, jump_rules(door, iface), door.chain)


def remove(iface):
    for tool in TOOL.values():
        unhook(tool, jump_rules(DOOR, iface), DOOR.chain)
    remove_former(iface)


def install():
    me = os.path.abspath(__file__)
    with open(CRON, "w") as f:
        f.write("# EDGE-1-h, NIN-1-b4: 80/443 admit the approved edges only, in step with their lists.\n"
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
    try:
        ranges = all_ranges()
    except edge_ranges.RangeError as e:
        print(f"the chain left as it was: {e}", file=sys.stderr)
        return 1
    (_show if cmd == "print" else apply)(DOOR, ranges, iface)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv) or 0)
