#!/usr/bin/env python3
"""The production host admits 80/443 from Cloudflare's published ranges only.

ADR-0129 amendment 1, EDGE-1-h; a k3s host since OPS-1-o-g (hosting K9). This sits on top of EDGE-1-g: the gateway
already refuses any TLS handshake without our origin-pull certificate, and this
keeps everyone else from reaching the gateway at all. Dev keeps its open ports.

    cloudflare_firewall.py apply      fetch the list, rebuild the chain, hook it in
    cloudflare_firewall.py print      what `apply` would write, changing nothing
    cloudflare_firewall.py remove     unhook and delete the chain (ports open again)
    cloudflare_firewall.py install    /etc/cron.d entry: at boot and daily

Cloudflare's list comes from https://api.cloudflare.com/client/v4/ips (no
token). A list that is short, malformed or failed to arrive is refused and the
last good one, cached in STATE, is used instead: an empty chain would drop
every visitor. EDGE_PUBLIC_IFACE names the public interface (default: the one
the default route leaves by); bridges and the tunnel interfaces are never
filtered. Contract: docs/platform/hosting/contract.origin.md.
"""
import ipaddress
import json
import os
import sys
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from edge_chain import TOOL, hook_all, public_iface, run, unhook  # noqa: E402

CHAIN = "TXNET-EDGE"
SOURCE = "https://api.cloudflare.com/client/v4/ips"
STATE = os.environ.get("EDGE_FIREWALL_STATE", "/var/lib/txnet/cloudflare-ips.json")
# Cloudflare publishes 15 IPv4 and 7 IPv6 ranges (2026-10). Far fewer means
# a broken answer, not a smaller Cloudflare.
MINIMUM = {4: 10, 6: 5}
# Nothing Cloudflare publishes is wider than this; a wider one admits the world.
WIDEST = {4: 8, 6: 16}
CRON = "/etc/cron.d/txnet-cloudflare-firewall"


class RangeError(ValueError):
    pass


def parse_ranges(body):
    """Cloudflare's answer -> {4: [...], 6: [...]}, or RangeError."""
    try:
        data = json.loads(body)
        result = data["result"] if data.get("success") else None
        lists = {4: result["ipv4_cidrs"], 6: result["ipv6_cidrs"]}
    except (ValueError, TypeError, KeyError) as e:
        raise RangeError(f"not Cloudflare's list: {e}") from e
    for family, cidrs in lists.items():
        if len(cidrs) < MINIMUM[family]:
            raise RangeError(f"IPv{family}: {len(cidrs)} ranges, expected at least {MINIMUM[family]}")
        for cidr in cidrs:
            try:
                net = ipaddress.ip_network(cidr)
            except ValueError as e:
                raise RangeError(f"IPv{family}: {cidr!r}: {e}") from e
            if net.version != family or net.prefixlen < WIDEST[family]:
                raise RangeError(f"IPv{family}: {cidr} is not a Cloudflare range")
    return lists


def restore_payload(cidrs, iface):
    """One atomic `iptables-restore --noflush` write: the chain is redeclared
    (which empties it) and refilled in the same commit."""
    lines = ["*filter", f":{CHAIN} - [0:0]", f"# Cloudflare's ranges for {iface}, from {SOURCE}"]
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


def current_ranges():
    """Fresh from Cloudflare, else the last good list, else refuse."""
    try:
        with urllib.request.urlopen(SOURCE, timeout=30) as resp:
            body = resp.read().decode()
        ranges = parse_ranges(body)
        os.makedirs(os.path.dirname(STATE), exist_ok=True)
        with open(STATE + ".tmp", "w") as f:
            f.write(body)
        os.replace(STATE + ".tmp", STATE)
        return ranges
    except (OSError, RangeError) as e:
        print(f"Cloudflare's list unusable ({e}); using {STATE}", file=sys.stderr)
        with open(STATE) as f:
            return parse_ranges(f.read())


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
        ranges = current_ranges()
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
