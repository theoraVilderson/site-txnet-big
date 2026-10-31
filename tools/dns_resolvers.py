#!/usr/bin/env python3
"""Domestic DNS resolvers on every host, from one file (NIN-1-l, hosting contract.nodes.md "Domestic DNS").

When the international internet is cut, a host asking Google's resolvers finds
no name at all, domestic ones included: the registry, the S3 storage, a
gateway, a reseller's panel. Cluster names still resolve (CoreDNS answers
them itself); every other name is forwarded to the host's upstreams.

    scripts/dns.sh check                 each resolver in the file, against each name it must answer
    scripts/dns.sh set A [B ...]         the domestic resolvers become A, B…, then `apply` here
    scripts/dns.sh apply [--restart-docker[=idle]]   this host: systemd-resolved, Docker, k3s's CoreDNS
    scripts/dns.sh apply --prod          the same on production, over ssh (STAGING_PROD_SSH in .env.dev)

It runs on its own wherever a server starts serving (NIN-1-l): a cluster move's
`mute`, a server move's `presync`, `backup.py restore`, and every release's `dns` step.

The file is dev-docker/dns/resolvers.txt: `domestic`, then `fallback`
(asked only when no domestic one answers), then the `check` names. Nothing is
written unless a domestic resolver answers every check name from this host,
and a host whose names stop resolving after the change gets its old settings
back. Docker's own setting takes effect when Docker restarts, which restarts
every container: `--restart-docker` does it now, and is asked for by name;
`--restart-docker=idle` only when no container runs on the host (a new server).
"""
import argparse
import dataclasses
import ipaddress
import json
import os
import random
import shlex
import shutil
import socket
import struct
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FILE = ROOT / "dev-docker" / "dns" / "resolvers.txt"
RESOLVED_DROPIN = Path("/etc/systemd/resolved.conf.d/txnet-dns.conf")
DOCKER_CONF = Path("/etc/docker/daemon.json")
PROD_ENV = ROOT / ".env.dev"  # the build host's: STAGING_PROD_SSH names production (OPS-1-am-f)
QUERY_TIMEOUT_S = 2
DNS_PORT = 53
COREDNS_WAIT = "120s"
KINDS = ("domestic", "fallback", "check")


class DnsError(Exception):
    """The file or the host refuses the change; the message names what."""


@dataclasses.dataclass
class Plan:
    domestic: list
    fallback: list
    check: list


def say(message, *args):
    print("dns: " + (message % args if args else message), flush=True)


def parse(text):
    """The file as a Plan, in its own order; a bad line is refused by its number."""
    plan = Plan([], [], [])
    for number, raw in enumerate(text.splitlines(), 1):
        words = raw.split("#")[0].split()
        if not words:
            continue
        if len(words) != 2 or words[0] not in KINDS:
            raise DnsError("line %d: expected `<%s> <value>`: %r" % (number, "|".join(KINDS), raw.strip()))
        kind, value = words
        if kind != "check":
            try:
                ipaddress.ip_address(value)
            except ValueError:
                raise DnsError("line %d: %r is not an IP address" % (number, value)) from None
        getattr(plan, kind).append(value)
    if not plan.domestic:
        raise DnsError("no domestic resolver in the file")
    if not plan.check:
        raise DnsError("no check name: a resolver is judged by the names this platform needs")
    return plan


def with_domestic(text, servers):
    """The file with its domestic lines replaced by servers, everything else kept."""
    for server in servers:
        ipaddress.ip_address(server)
    kept = [line for line in text.splitlines() if line.split("#")[0].split()[:1] != ["domestic"]]
    at = next((i for i, line in enumerate(kept) if line.split("#")[0].split()[:1] in (["fallback"], ["check"])), len(kept))
    return "\n".join(kept[:at] + ["domestic %s" % s for s in servers] + kept[at:]) + "\n"


def resolved_conf(plan):
    """systemd-resolved's drop-in: the domestic asked first, the fallback only when none answers."""
    return ("# Written by tools/dns_resolvers.py from dev-docker/dns/resolvers.txt (NIN-1-l); edit that file.\n"
            "[Resolve]\nDNS=%s\nFallbackDNS=%s\n" % (" ".join(plan.domestic), " ".join(plan.fallback)))


def docker_conf(current, plan):
    """daemon.json with `dns` set to the same order; every other setting kept."""
    settings = json.loads(current) if current.strip() else {}
    settings["dns"] = plan.domestic + plan.fallback
    return json.dumps(settings, indent=2) + "\n"


def query(name, ident):
    """One recursive question for name's A record."""
    labels = b"".join(bytes([len(part)]) + part.encode("ascii") for part in name.strip(".").split("."))
    return struct.pack(">HHHHHH", ident, 0x0100, 1, 0, 0, 0) + labels + b"\x00" + struct.pack(">HH", 1, 1)


def answered(question, response):
    """True when response answers question (same id) with no error and at least one record."""
    if len(response) < 12:
        return False
    ident, flags, _, count = struct.unpack(">HHHH", response[:8])
    return ident == struct.unpack(">H", question[:2])[0] and flags & 0x000F == 0 and count > 0


def probe(server, name):
    """Whether server answers name from this host, over UDP, within QUERY_TIMEOUT_S."""
    question = query(name, random.randrange(1 << 16))
    family = socket.AF_INET6 if ipaddress.ip_address(server).version == 6 else socket.AF_INET
    with socket.socket(family, socket.SOCK_DGRAM) as sock:
        sock.settimeout(QUERY_TIMEOUT_S)
        try:
            sock.sendto(question, (server, DNS_PORT))
            return answered(question, sock.recv(4096))
        except OSError:
            return False


def usable(plan, probe=probe):
    """The domestic resolvers answering every check name; refuses when there is none."""
    good = [s for s in plan.domestic if all(probe(s, name) for name in plan.check)]
    if not good:
        raise DnsError("no domestic resolver answers %s from this host: nothing was changed" % ", ".join(plan.check))
    return good


def report(plan):
    for server in plan.domestic + plan.fallback:
        kind = "domestic" if server in plan.domestic else "fallback"
        missed = [name for name in plan.check if not probe(server, name)]
        say("%-8s %-16s %s", kind, server, "answers all" if not missed else "does not answer " + ", ".join(missed))


def run(argv, check=True):
    return subprocess.run(argv, check=check, capture_output=True, text=True)


def resolves_now(plan):
    """Every check name through the host's own resolver, as a service on it would ask."""
    return all(run(["resolvectl", "query", "--legend=no", name], check=False).returncode == 0 for name in plan.check)


def apply_resolved(plan):
    old = RESOLVED_DROPIN.read_text() if RESOLVED_DROPIN.exists() else None
    RESOLVED_DROPIN.parent.mkdir(parents=True, exist_ok=True)
    RESOLVED_DROPIN.write_text(resolved_conf(plan))
    run(["systemctl", "restart", "systemd-resolved"])
    if resolves_now(plan):
        say("systemd-resolved: %s first, %s as fallback", " ".join(plan.domestic), " ".join(plan.fallback) or "none")
        return
    if old is None:
        RESOLVED_DROPIN.unlink()
    else:
        RESOLVED_DROPIN.write_text(old)
    run(["systemctl", "restart", "systemd-resolved"])
    raise DnsError("names stopped resolving through systemd-resolved; its old settings are back")


def docker_idle():
    """No container runs here, so restarting Docker stops nobody."""
    done = run(["docker", "ps", "-q"], check=False)
    return done.returncode != 0 or not done.stdout.strip()


def apply_docker(plan, restart):
    """restart: "yes", "idle" (only when docker_idle) or "" (written, applied at Docker's next start)."""
    current = DOCKER_CONF.read_text() if DOCKER_CONF.exists() else ""
    wanted = docker_conf(current, plan)
    if json.loads(wanted) == (json.loads(current) if current.strip() else {}):
        say("Docker: already %s", " ".join(plan.domestic + plan.fallback))
        return
    DOCKER_CONF.parent.mkdir(parents=True, exist_ok=True)
    DOCKER_CONF.write_text(wanted)
    if restart != "yes" and not (restart == "idle" and docker_idle()):
        say("Docker: written; it takes effect when Docker restarts (every container restarts): --restart-docker")
        return
    run(["systemctl", "restart", "docker"])
    say("Docker: restarted with %s", " ".join(plan.domestic + plan.fallback))


def apply_coredns():
    """CoreDNS reads the host's upstreams when its pod starts (k3s: /run/systemd/resolve/resolv.conf).
    k3s runs one replica, which a restart may take down before its successor answers: a second
    one first, so a pod is always answering, then back to what it was."""
    kubectl = ["k3s", "kubectl", "-n", "kube-system"]
    deployment = "deployment/coredns"
    replicas = run(kubectl + ["get", deployment, "-o", "jsonpath={.spec.replicas}"]).stdout.strip() or "1"
    wait = kubectl + ["rollout", "status", deployment, "--timeout=" + COREDNS_WAIT]
    try:
        run(kubectl + ["scale", deployment, "--replicas=%d" % max(2, int(replicas))])
        run(wait)
        run(kubectl + ["rollout", "restart", deployment])
        run(wait)
    finally:
        run(kubectl + ["scale", deployment, "--replicas=" + replicas])
    say("k3s: CoreDNS restarted on the new upstreams, never without a pod answering")


def apply_here(plan, restart_docker):
    say("answering every check name: %s", " ".join(usable(plan)))
    if Path("/run/systemd/resolve").is_dir():
        apply_resolved(plan)
    if DOCKER_CONF.exists() or shutil.which("dockerd"):
        apply_docker(plan, restart_docker)
    if shutil.which("k3s"):
        apply_coredns()


def prod_target():
    env = dict(line.split("=", 1) for line in PROD_ENV.read_text().splitlines()
               if "=" in line and not line.lstrip().startswith("#"))
    target, key = env.get("STAGING_PROD_SSH", "").strip(), env.get("STAGING_PROD_SSH_KEY", "").strip()
    if not target or not key:
        raise DnsError("STAGING_PROD_SSH and STAGING_PROD_SSH_KEY are not set in %s" % PROD_ENV)
    return target, key


def apply_remote(target, key, restart_docker=""):
    """`apply` on another server: this tool and the file copied to a private directory there,
    run, removed, so its checkout need not have them (a move's new server, production)."""
    ssh = ["ssh", "-i", key, "-o", "BatchMode=yes", target]
    there = run(ssh + ["mktemp -d"]).stdout.strip()
    try:
        run(["scp", "-q", "-i", key, "-o", "BatchMode=yes", __file__, str(FILE), "%s:%s/" % (target, there)])
        argv = ["python3", "%s/dns_resolvers.py" % there, "apply", "--file", "%s/%s" % (there, FILE.name)]
        done = subprocess.run(ssh + [shlex.join(argv + (["--restart-docker=" + restart_docker] if restart_docker else []))],
                              text=True, capture_output=True)
        print(done.stdout, end="")
        if done.returncode:
            raise DnsError("%s: %s" % (target, done.stderr.strip() or done.stdout.strip().splitlines()[-1]))
    finally:
        run(ssh + ["rm -rf " + shlex.quote(there)], check=False)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["check", "set", "apply"])
    parser.add_argument("servers", nargs="*", help="set: the domestic resolvers, in order")
    parser.add_argument("--file", default=str(FILE))
    parser.add_argument("--prod", action="store_true", help="apply on production instead of here")
    parser.add_argument("--restart-docker", nargs="?", const="yes", default="", choices=["yes", "idle"],
                        help="restart Docker now (every container); =idle only when no container runs")
    args = parser.parse_args(argv)
    path = Path(args.file)
    try:
        if args.command == "set":
            if not args.servers:
                parser.error("set needs at least one domestic resolver")
            text = with_domestic(path.read_text(), args.servers)
            usable(parse(text))  # refuses before the file changes
            path.write_text(text)
            say("%s: domestic %s", path, " ".join(args.servers))
        plan = parse(path.read_text())
        if args.command == "check":
            report(plan)
        elif args.prod:
            apply_remote(*prod_target(), restart_docker=args.restart_docker)
        else:
            apply_here(plan, args.restart_docker)
    except (DnsError, subprocess.CalledProcessError, OSError, ValueError) as err:
        detail = getattr(err, "stderr", None)
        say("STOPPED: %s%s", err, (": " + detail.strip()) if detail else "")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
