#!/usr/bin/env python3
"""Production's cluster moves to another server, one writer at any moment (OPS-1-am-a, hosting K21).

Run on the build host (it reaches both servers), from the repo root:

  cluster_move.py rehearse|move --from root@OLD --from-key K --to root@NEW --to-key K
      starts a run; `rehearse` reads production's newest bundle and never touches it
  cluster_move.py <step>     the next step of the run started; each refuses out of order:
      check    both servers, their clocks, the room, production's commit
      mute     NEW sends nothing out but to the registry and its resolvers, from now and after a reboot
      install  k3s at the pin, the checkout at production's commit, the keys, the edge chains
      deploy   `prod.k8s.sh deploy` there: an empty cluster, muted
      stop     OLD's workloads but the stores to zero, its bundle timers off, checked at zero
      bundle   a fresh bundle on OLD, refused if older than the stop (rehearse: the newest), to NEW
      restore  B10's restore on NEW over its seeded data, never scrubbed
      fence    OLD's stores to zero, the marker, k3s stopped and disabled
      open     only with OLD fenced, read again now: NEW unmuted, its bot re-registers
      repoint  both edges to NEW (edge_zone.py; mytxnet.ir refused without the user's word)
      rejoin   the build host leaves OLD and joins NEW as its no-release agent
  cluster_move.py status

Runbook: docs/operations/runbook-move-cluster.md
"""
import argparse
import json
import os
import shlex
import subprocess
import sys
import time

import cluster_fence as cf
import cluster_open as co

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
STATE = os.path.join(ROOT, ".move", "cluster.json")
CHECKOUT = "/root/site-txnet-big"
SHM = "/dev/shm/txnet-move"
BUNDLE_DIR = "/var/backups/txnet/bundles"
PASSPHRASE = "dev-docker/secrets/backup-bundle-passphrase"
CARRIED = ("/etc/rancher/k3s/registries.yaml", "/etc/txnet/age.key",
           "/usr/local/bin/sops", "/usr/local/bin/age", "/usr/local/bin/age-keygen")
MUTE_FILE = "/etc/txnet/move-mute.nft"
MUTE_UNIT = "txnet-move-mute"
MAX_CLOCK_SKEW_S = 5
DISK_HEADROOM = 1.2  # the data grows between the check and the move
# kubectl waits and the bundle on an 8-core server at load 15 (2026-10-31)
LONG_S = 3600
KUBE = "kubectl -n txnet"
WORKLOADS = "deployments,statefulsets"


def say(message, *args):
    print("cluster-move: " + (message % args if args else message), flush=True)


class Server:
    """One end of the move, over ssh as root."""

    def __init__(self, target, key):
        self.target, self.key = target, key
        self.address = target.split("@")[-1]

    def ssh(self, command):
        return ["ssh", "-i", self.key, "-o", "BatchMode=yes", "-o", "IdentitiesOnly=yes",
                "-o", "ServerAliveInterval=30", self.target, command]

    def run(self, command, timeout=600, check=True):
        done = subprocess.run(self.ssh(command), capture_output=True, text=True, timeout=timeout)
        if check and done.returncode != 0:
            raise cf.MoveError("%s: `%s` failed: %s" % (self.address, command[:80], done.stderr.strip()[-400:]))
        return done.stdout

    def pull(self, remote, local):
        with open(local, "wb") as f:
            subprocess.run(self.ssh("cat %s" % shlex.quote(remote)), stdout=f, check=True, timeout=LONG_S)

    def push(self, local, remote, mode="0600"):
        with open(local, "rb") as f:
            subprocess.run(self.ssh("install -d -m 0700 %s && umask 077 && cat > %s && chmod %s %s" % (
                shlex.quote(os.path.dirname(remote)), shlex.quote(remote), mode, shlex.quote(remote))),
                stdin=f, check=True, timeout=LONG_S)


def load_state():
    try:
        with open(STATE) as f:
            return json.load(f)
    except FileNotFoundError:
        raise cf.MoveError("no run started: `rehearse` or `move` first") from None


def save_state(state):
    os.makedirs(os.path.dirname(STATE), exist_ok=True)
    with open(STATE, "w") as f:
        json.dump(state, f, indent=2)


def pods(server):
    return server.run("kubectl get pods -A -o json", timeout=300)


# -- steps -----------------------------------------------------------------

def check(state, old, new):
    clocks = {s.address: int(s.run("date +%s")) for s in (old, new)}
    skew = abs(clocks[old.address] - clocks[new.address])
    if skew > MAX_CLOCK_SKEW_S:
        raise cf.MoveError("the clocks are %ds apart: sessions and Redis expiries would shift" % skew)
    commit = old.run("git -C %s rev-parse HEAD" % CHECKOUT).strip()
    if old.run("git -C %s status --porcelain --untracked-files=no" % CHECKOUT).strip():
        raise cf.MoveError("production's checkout has changes; the move deploys its commit, not them")
    data = int(old.run("du -sx -B1 /var/lib/rancher/k3s/storage | cut -f1", timeout=LONG_S))
    free = int(new.run("df --output=avail -B1 /var/lib | tail -1"))
    if free < data * DISK_HEADROOM:
        raise cf.MoveError("%s has %d GiB free for %d GiB of data" % (new.address, free >> 30, data >> 30))
    say("clocks %ds apart; production at %s; %d GiB of data, %d GiB free there", skew, commit[:8], data >> 30, free >> 30)
    say("before `move`: the panels, RADIUS, the gateway and SMS allow %s (OPS-1-am-d)", new.address)
    state["commit"] = commit


def mute(state, old, new):
    registry = old.run("python3 -c 'import sys, yaml; print(next(iter(yaml.safe_load(open(sys.argv[1]))[\"configs\"])))' "
                       "/etc/rancher/k3s/registries.yaml").strip()
    allowed = sorted(set(new.run("getent ahostsv4 %s | cut -d' ' -f1" % shlex.quote(registry)).split()))
    resolvers = sorted(set(new.run("awk '/^nameserver/{print $2}' /run/systemd/resolve/resolv.conf").split()))
    rules = cf.mute_ruleset(allowed, [r for r in resolvers if ":" not in r])
    unit = ("[Unit]\nDescription=TXNet move: this server sends nothing out (hosting K21)\n"
            "Before=k3s.service\n[Service]\nType=oneshot\nRemainAfterExit=yes\n"
            "ExecStart=/usr/sbin/nft -f %s\nExecStop=/usr/sbin/nft delete table inet %s\n"
            "[Install]\nWantedBy=multi-user.target\n" % (MUTE_FILE, cf.MUTE_TABLE))
    new.run("install -d /etc/txnet && cat > %s <<'EOF'\n%sEOF\ncat > /etc/systemd/system/%s.service <<'EOF'\n%sEOF\n"
            "systemctl daemon-reload && (nft list table inet %s >/dev/null 2>&1 && nft delete table inet %s; true) "
            "&& systemctl enable %s && systemctl restart %s" % (
                MUTE_FILE, rules, MUTE_UNIT, unit, cf.MUTE_TABLE, cf.MUTE_TABLE, MUTE_UNIT, MUTE_UNIT))
    if new.run("curl --noproxy '*' -s -m 5 -o /dev/null https://1.1.1.1 && echo open", check=False).strip():
        raise cf.MoveError("%s still reaches 1.1.1.1 with the mute on" % new.address)
    code = new.run("curl --noproxy '*' -s -m 10 -o /dev/null -w '%%{http_code}' https://%s/v2/" % registry, check=False)
    say("%s is mute: 1.1.1.1 unanswered, the registry %s answers %s (%s)", new.address, registry, code, ", ".join(allowed))


def install(state, old, new):
    os.makedirs(SHM, mode=0o700, exist_ok=True)
    try:
        for path in CARRIED:  # through memory only: the age key opens every sealed secret
            local = os.path.join(SHM, os.path.basename(path))
            old.pull(path, local)
            new.push(local, path, "0755" if path.startswith("/usr/local/bin") else "0600")
    finally:
        subprocess.run(["rm", "-rf", SHM], check=True)
    ref = "refs/move/at"
    subprocess.run(["git", "-C", ROOT, "update-ref", ref, state["commit"]], check=True)
    bundle = os.path.join(ROOT, ".move", "checkout.bundle")
    subprocess.run(["git", "-C", ROOT, "bundle", "create", bundle, ref], check=True, capture_output=True)
    subprocess.run(["git", "-C", ROOT, "update-ref", "-d", ref], check=True)
    new.push(bundle, "/root/move-checkout.bundle")
    new.run("[ -d %s/.git ] || git clone -q /root/move-checkout.bundle %s; cd %s && git fetch -q /root/move-checkout.bundle "
            "%s && git checkout -q %s && rm /root/move-checkout.bundle" % (CHECKOUT, CHECKOUT, CHECKOUT, ref, state["commit"]))
    install_k3s(new)


def install_k3s(new):
    """The server at k8s/versions.env's pin, staged from here: a mute server reaches no GitHub."""
    pins = dict(line.split("=", 1) for line in open(os.path.join(ROOT, "k8s/versions.env")).read().split()
                if "=" in line and not line.startswith("#"))
    script = os.path.join(ROOT, ".move", "k3s-install.sh")
    subprocess.run(["curl", "-fsSL", "-o", script, "https://raw.githubusercontent.com/k3s-io/k3s/%s/install.sh"
                    % pins["K3S_VERSION"]], check=True)
    sums = "%s  /usr/local/bin/k3s\n%s  %s\n" % (pins["K3S_SHA256"], pins["K3S_INSTALL_SHA256"], script)
    subprocess.run(["sha256sum", "-c", "--quiet"], input=sums, text=True, check=True)
    new.push("/usr/local/bin/k3s", "/usr/local/bin/k3s", "0755")
    new.push(script, "/root/k3s-install.sh", "0700")
    new.run("install -m 0600 %s/k8s/k3s/config.yaml /etc/rancher/k3s/config.yaml && "
            "INSTALL_K3S_SKIP_DOWNLOAD=true INSTALL_K3S_VERSION='%s' sh /root/k3s-install.sh && rm /root/k3s-install.sh "
            "&& cd %s && python3 scripts/edge/k3s_ports.py install && python3 scripts/edge/k3s_ports.py apply "
            "&& python3 scripts/edge/edge_firewall.py apply && python3 scripts/edge/edge_firewall.py install "
            "&& kubectl wait --for=condition=Ready node --all --timeout=300s" % (CHECKOUT, pins["K3S_VERSION"], CHECKOUT),
            timeout=LONG_S)
    say("k3s %s is up on %s, its chains in place", pins["K3S_VERSION"], new.address)


def deploy(state, old, new):
    new.run("cd %s && IMAGE_TAG=%s HOST_GATEWAY=%s scripts/prod.k8s.sh deploy" % (CHECKOUT, state["commit"], new.address),
            timeout=LONG_S)
    say("%s runs production's release at %s, empty and mute", new.address, state["commit"][:8])


def stop(state, old, new):
    started = time.monotonic()
    keep = " ".join(cf.STORES)
    for ns in cf.NAMESPACES:
        old.run("for t in $(kubectl -n %s get %s -o name); do case \"${t#*/}\" in %s) continue;; esac; "
                "kubectl -n %s annotate --overwrite $t txnet.io/replicas-before-move=$(kubectl -n %s get $t "
                "-o jsonpath='{.spec.replicas}') && kubectl -n %s scale $t --replicas=0; done" % (
                    ns, WORKLOADS, keep.replace(" ", "|"), ns, ns, ns), timeout=LONG_S)
    old.run("systemctl disable --now %s" % " ".join(cf.HOST_TIMERS))
    deadline = time.monotonic() + LONG_S
    while (left := cf.writers_left(pods(old))) and time.monotonic() < deadline:
        time.sleep(5)
    if left:
        raise cf.MoveError("still running on the old cluster: %s" % ", ".join(left))
    state["stop_at"] = int(old.run("date +%s"))
    state.setdefault("figures", {})["stop_s"] = round(time.monotonic() - started)
    say("the old cluster writes nothing but its stores; the platform is down from here")


def newest_bundle(server):
    names = [n for n in server.run("ls -1 %s" % BUNDLE_DIR).split() if n.endswith(".gpg")]
    if not names:
        raise cf.MoveError("no bundle in %s" % BUNDLE_DIR)
    return max(names)  # the name carries its UTC time: txnet-backup-txnet-2026-10-31_03-00-04Z


def bundle_created(name):
    """`txnet-backup-<project>-YYYY-MM-DD_HH-MM-SSZ.tar.zst.gpg` -> the manifest's `created` form."""
    stamp = name.split(".")[0][-20:]
    return stamp[:10] + "T" + stamp[11:].replace("-", ":")


def bundle(state, old, new):
    started = time.monotonic()
    if state["mode"] == "move":
        left = cf.writers_left(pods(old))
        if left:
            raise cf.MoveError("the old cluster is not at zero: %s" % ", ".join(left))
        old.run("cd %s && python3 scripts/bundle/backup.py --stack k8s now" % CHECKOUT, timeout=LONG_S)
    name = newest_bundle(old)
    if state["mode"] == "move":
        refusal = cf.stale_bundle(bundle_created(name), state["stop_at"])
        if refusal:
            raise cf.MoveError(refusal)
    state.setdefault("figures", {})["bundle_make_s"] = round(time.monotonic() - started)
    os.makedirs(SHM, mode=0o700, exist_ok=True)
    for remote, local in ((os.path.join(BUNDLE_DIR, name), name), (os.path.join(BUNDLE_DIR, name + ".sha256"), name + ".sha256"),
                          (os.path.join(CHECKOUT, PASSPHRASE), "passphrase")):
        old.pull(remote, os.path.join(SHM, local))
    subprocess.run("cd %s && sha256sum -c --quiet %s.sha256" % (SHM, shlex.quote(name)), shell=True, check=True)
    for local in (name, "passphrase"):
        new.push(os.path.join(SHM, local), os.path.join(SHM, local))
    subprocess.run(["rm", "-rf", SHM], check=True)
    state["bundle"] = name
    state["figures"]["bundle_total_s"] = round(time.monotonic() - started)
    say("%s on %s in %ds", name, new.address, state["figures"]["bundle_total_s"])


def restore(state, old, new):
    refusal = cf.refuse_scrub(os.environ)
    if refusal:
        raise cf.MoveError(refusal)
    started = time.monotonic()
    argv = cf.restore_argv(CHECKOUT, os.path.join(SHM, state["bundle"]), os.path.join(SHM, "passphrase"))
    try:
        print(new.run("cd %s && %s" % (CHECKOUT, shlex.join(argv)), timeout=LONG_S * 2), end="")
    finally:
        new.run("rm -rf %s" % SHM, check=False)
    state["figures"]["restore_s"] = round(time.monotonic() - started)
    say("restored on %s in %ds, still mute", new.address, state["figures"]["restore_s"])


STEPS = {"check": check, "mute": mute, "install": install, "deploy": deploy, "stop": stop,
         "bundle": bundle, "restore": restore}


def run_step(state, step):
    refusal = cf.out_of_order(state, step)
    if refusal:
        raise cf.MoveError(refusal)
    old = Server(state["from"], state["from_key"])
    new = Server(state["to"], state["to_key"])
    started = time.monotonic()
    (STEPS.get(step) or co.STEPS[step])(state, old, new)
    state["done"][step] = int(time.time())
    state.setdefault("figures", {})[step + "_step_s"] = round(time.monotonic() - started)
    save_state(state)


def main(argv=None):
    every = cf.STEPS["move"]
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=("rehearse", "move", "status") + every)
    parser.add_argument("--from", dest="old", help="production's server, root@address")
    parser.add_argument("--from-key", help="the identity that reaches it")
    parser.add_argument("--to", dest="new", help="the new server, root@address")
    parser.add_argument("--to-key", help="the identity that reaches it")
    args = parser.parse_args(argv)
    try:
        if args.command in cf.STEPS:
            if not all((args.old, args.from_key, args.new, args.to_key)):
                parser.error("%s needs --from, --from-key, --to and --to-key" % args.command)
            save_state({"mode": args.command, "from": args.old, "from_key": args.from_key,
                        "to": args.new, "to_key": args.to_key, "done": {}, "figures": {}})
            say("a %s from %s to %s begins: next `check`", args.command, args.old, args.new)
        elif args.command == "status":
            print(json.dumps(load_state(), indent=2))
        else:
            run_step(load_state(), args.command)
    except cf.MoveError as err:
        say("REFUSED: %s", err)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
