"""What every edge chain on the production host shares: running iptables, the
public interface, and keeping a chain's jumps on top (hosting O7, K13).

`edge_firewall.py` (each door's ports from its own edges only, one chain a
door) and `k3s_ports.py` (k3s's own ports closed) own the chains named `TXNET-*`.
"""
import os
import subprocess
import sys

TOOL = {4: "iptables", 6: "ip6tables"}
# Every chain an edge script owns starts so; see on_top().
PREFIX = "TXNET-"


def run(*args, check=True, stdin=None):
    """One iptables (or other) command, its output captured."""
    return subprocess.run(args, input=stdin, text=True, capture_output=True, check=check)


def public_iface():
    """EDGE_PUBLIC_IFACE, else the interface the default route leaves by."""
    if os.environ.get("EDGE_PUBLIC_IFACE"):
        return os.environ["EDGE_PUBLIC_IFACE"]
    out = subprocess.run(["ip", "route", "get", "1.1.1.1"], capture_output=True, text=True, check=True).stdout
    words = out.split()
    return words[words.index("dev") + 1]


def _rules(listing):
    return [line.split() for line in listing.splitlines() if line.startswith("-A ")]


def our_positions(listing, target):
    """The 1-based numbers of the rules in `iptables -S <chain>` that jump to target."""
    return [n for n, rule in enumerate(_rules(listing), 1) if rule[-2:] == ["-j", target]]


def on_top(listing, target, count):
    """Whether target's `count` jumps lead the chain. Another edge chain's jumps
    do not count against it: each decides only its own ports, so their order
    among themselves changes nothing, and two scripts each insisting on first
    place would reorder the chain on every run."""
    rules = [r for r in _rules(listing)
             if not (r[-2] == "-j" and r[-1].startswith(PREFIX) and r[-1] != target)]
    return [n for n, r in enumerate(rules, 1) if r[-2:] == ["-j", target]] == list(range(1, count + 1))


def hook(tool, chain, jumps, target):
    """Put `jumps` ahead of every other rule in `chain`. A rule above ours
    decides first, and Docker and k3s both insert theirs at the top. Fresh
    copies go on top before the stale ones are deleted, by number, so the
    chain is never unhooked in between; re-running adds no second jump."""
    listing = run(tool, "-S", chain).stdout
    if on_top(listing, target, len(jumps)) and \
            all(run(tool, "-C", chain, *args, check=False).returncode == 0 for args in jumps):
        return
    for args in reversed(jumps):
        run(tool, "-I", chain, "1", *args)
    for number in reversed(our_positions(run(tool, "-S", chain).stdout, target)[len(jumps):]):
        run(tool, "-D", chain, str(number))


def hook_all(tool, jumps, target):
    """hook() each chain `jumps` names, in order. A chain the host lacks is
    skipped: Docker creates DOCKER-USER, a k3s host has none, and on a Docker
    host where it has not started yet the rule waits for the next run."""
    for chain in dict.fromkeys(c for c, _ in jumps):
        if run(tool, "-n", "-L", chain, check=False).returncode != 0:
            print(f"{tool}: no {chain} chain", file=sys.stderr)
            continue
        hook(tool, chain, [args for c, args in jumps if c == chain], target)


def unhook(tool, jumps, target):
    """Delete every copy of `jumps`, then the chain itself."""
    for chain, args in jumps:
        while run(tool, "-D", chain, *args, check=False).returncode == 0:
            pass
    run(tool, "-F", target, check=False)
    run(tool, "-X", target, check=False)
