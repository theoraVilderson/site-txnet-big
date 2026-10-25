#!/usr/bin/env python3
"""The production host admits 80/443 from Cloudflare's published ranges only.

ADR-0129 amendment 1, EDGE-1-h; a k3s host since OPS-1-o-g (hosting K9). This sits on top of EDGE-1-g: the gateway
already refuses any TLS handshake without our origin-pull certificate, and this
keeps everyone else from reaching the gateway at all. Dev keeps its open ports.

    cloudflare_firewall.py apply      fetch the list, rebuild the chain, hook it in
    cloudflare_firewall.py print      what `apply` would write, changing nothing
    cloudflare_firewall.py remove     unhook and delete the chain (ports open again)
    cloudflare_firewall.py install    /etc/cron.d entry: at boot and daily

Cloudflare's list is its row of edges.json, re-read through edge_ranges.py
(NIN-1-b1): a list that is short, malformed or failed to arrive is refused and
the last good copy is used instead, since an empty chain would drop every
visitor. EDGE_PUBLIC_IFACE names the public interface (default: the one
the default route leaves by); bridges and the tunnel interfaces are never
filtered. Contract: docs/platform/hosting/contract.origin.md.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import edge_ranges  # noqa: E402
from edge_chain import TOOL, hook_all, public_iface, run, unhook  # noqa: E402

CHAIN = "TXNET-EDGE"
# Its row in edges.json.
EDGE = "cloudflare"
CRON = "/etc/cron.d/txnet-cloudflare-firewall"


def restore_payload(cidrs, iface):
    """One atomic `iptables-restore --noflush` write: the chain is redeclared
    (which empties it) and refilled in the same commit."""
    lines = ["*filter", f":{CHAIN} - [0:0]", f"# Cloudflare's ranges for {iface}, from edges.json"]
    lines += [f"-A {CHAIN} -s {cidr} -j RETURN" for cidr in cidrs]
    lines += [f"-A {CHAIN} -j DROP", "COMMIT"]
    return "\n".join(lines) + "\n"


def jump_rules(iface):
    """Where traffic for 80/443 enters the chain. INPUT covers a gateway on
    the host's own sockets. A published port is DNATed before it is forwarded,
    so the forwarded rules match the original destination port: FORWARD for
    k3s's load balancer (servicelb's hostPort, K9), DOCKER-USER for Docker's,
    which Docker keeps ahead of its own FORWARD rules across restarts."""
    rules = [("INPUT", ["-i", iface, "-p", "tcp", "-m", "multiport", "--dports", "80,443", "-j", CHAIN])]
    for chain in ("FORWARD", "DOCKER-USER"):
        for port in ("80", "443"):
            rules.append((chain, ["-i", iface, "-p", "tcp", "-m", "conntrack", "--ctorigdstport", port,
                                  "--ctdir", "ORIGINAL", "-j", CHAIN]))
    return rules


def apply(ranges, iface):
    for family, tool in TOOL.items():
        run(f"{tool}-restore", "--noflush", stdin=restore_payload(ranges[family], iface))
        hook_all(tool, jump_rules(iface), CHAIN)
        print(f"{tool}: {len(ranges[family])} Cloudflare ranges admitted on {iface}:80,443")


def remove(iface):
    for tool in TOOL.values():
        unhook(tool, jump_rules(iface), CHAIN)


def install():
    me = os.path.abspath(__file__)
    with open(CRON, "w") as f:
        f.write("# EDGE-1-h: admit 80/443 from Cloudflare only, in step with its list.\n"
                f"@reboot root sleep 90 && /usr/bin/python3 {me} apply\n"
                f"23 4 * * * root /usr/bin/python3 {me} apply\n")
    print(f"wrote {CRON}")


def main(argv):
    cmd = argv[1] if len(argv) > 1 else ""
    if cmd == "install":
        return install()
    iface = public_iface()
    if cmd == "remove":
        return remove(iface)
    if cmd in ("apply", "print"):
        ranges = edge_ranges.ranges(EDGE)
        if cmd == "print":
            for family in TOOL:
                print(restore_payload(ranges[family], iface))
            for chain, args in jump_rules(iface):
                print(chain, " ".join(args))
            return None
        return apply(ranges, iface)
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv) or 0)
