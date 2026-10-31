"""The move's second half: the old cluster fenced, the new one opened, the edges and the agent moved
(OPS-1-am-a, hosting K21). Each step takes (state, old, new) as cluster_move's do."""
import os
import subprocess
import time

import cluster_fence as cf

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CHECKOUT = "/root/site-txnet-big"
# The edges are driven from the build host with its own env: txnet.cyou's zone and barghgho.ir's name.
EDGE_ENV_FILE = ".env.dev"
EDGE_DOMAINS = ("DOMAIN_NAME", "DOMESTIC_DOMAIN_NAME")
WAIT_S = 3600
# The build host as a node of the new cluster: its ssh, as k8s-add-node.sh names it.
BUILD_HOST_ENV = "MOVE_BUILD_HOST"  # address[:port], e.g. 193.151.131.201:49222


def say(message, *args):
    print("cluster-move: " + (message % args if args else message), flush=True)


def evidence(old):
    """What the old server says now: k3s's state and the marker."""
    return {"k3s": old.run("systemctl is-active k3s", check=False).strip(),
            "marker": old.run("cat %s 2>/dev/null" % cf.MOVED_MARKER, check=False).strip()}


def fence(state, old, new):
    for ns in cf.NAMESPACES:
        old.run("kubectl -n %s scale %s --all --replicas=0" % (ns, "deployments,statefulsets"), timeout=WAIT_S)
    deadline = time.monotonic() + WAIT_S
    while (left := cf.writers_left(old.run("kubectl get pods -A -o json", timeout=300), keep=())) \
            and time.monotonic() < deadline:
        time.sleep(5)
    if left:
        raise cf.MoveError("the old stores did not stop: %s" % ", ".join(left))
    old.run("install -d /etc/txnet && echo %s > %s && systemctl disable --now k3s" % (new.address, cf.MOVED_MARKER))
    refusal = cf.not_fenced(evidence(old), new.address)
    if refusal:
        raise cf.MoveError(refusal)
    say("the old server is fenced: k3s stopped and disabled, %s names %s; its data is kept", cf.MOVED_MARKER, new.address)


def open_(state, old, new):
    refusal = cf.not_fenced(evidence(old), new.address)  # read now: the state file is not proof
    if refusal:
        raise cf.MoveError("not opened: " + refusal)
    new.run("systemctl disable --now txnet-move-mute && rm -f /etc/systemd/system/txnet-move-mute.service "
            "/etc/txnet/move-mute.nft && systemctl daemon-reload")
    if not new.run("curl --noproxy '*' -s -m 10 -o /dev/null https://1.1.1.1 && echo open", check=False).strip():
        raise cf.MoveError("%s is unmuted but still reaches nothing outside" % new.address)
    # the bot registered its webhook at boot, while mute (bot-webhook.registrar.ts)
    new.run("kubectl -n txnet rollout restart deployment/bot-service && "
            "kubectl -n txnet rollout status deployment/bot-service --timeout=600s", timeout=WAIT_S)
    state.setdefault("figures", {})["open_at"] = int(time.time())
    say("%s sends again; the bot re-registered", new.address)


def edge_env():
    with open(os.path.join(ROOT, EDGE_ENV_FILE)) as f:
        pairs = (line.split("#")[0].strip().split("=", 1) for line in f if "=" in line)
        return {k.strip(): v.strip() for k, v in pairs if len(k.split()) == 1}


def repoint(state, old, new):
    env = edge_env()
    for key in EDGE_DOMAINS:
        refusal = cf.refuse_live_domain(env.get(key, ""), os.environ)
        if refusal:
            raise cf.MoveError("%s: %s" % (key, refusal))
    run_env = {**os.environ, "ENV_FILE": EDGE_ENV_FILE}
    edge = os.path.join(ROOT, "scripts/edge/edge_zone.py")
    subprocess.run(["python3", edge, "repoint", old.address, new.address], env=run_env, cwd=ROOT, check=True)
    subprocess.run(["python3", edge, "arvan", "apply"], env={**run_env, "EDGE_ORIGIN_IP": new.address}, cwd=ROOT, check=True)
    state.setdefault("figures", {})["repoint_at"] = int(time.time())
    say("%s (Cloudflare) and %s (Arvan) point at %s", env.get("DOMAIN_NAME"), env.get("DOMESTIC_DOMAIN_NAME"), new.address)


def rejoin(state, old, new):
    host = os.environ.get(BUILD_HOST_ENV, "")
    if not host:
        raise cf.MoveError("%s=address[:port] names this build host as the new cluster reaches it" % BUILD_HOST_ENV)
    address, _, port = host.partition(":")
    port = port or "22"
    probe = "ssh -p %s -o BatchMode=yes -o ConnectTimeout=15 root@%s true" % (port, address)
    if subprocess.run(new.ssh(probe), capture_output=True).returncode != 0:
        raise cf.MoveError("%s cannot ssh to root@%s:%s: its key goes into this host's authorized_keys "
                           "(the user's call), then run rejoin again" % (new.address, address, port))
    subprocess.run(["bash", os.path.join(ROOT, "scripts/k8s-add-node.sh"), "leave"], check=True)
    new.run("cd %s && NODE_NO_RELEASE=1 scripts/k8s-add-node.sh join %s %s" % (CHECKOUT, address, port), timeout=WAIT_S)
    say("this build host left the old cluster and is %s's no-release agent", new.address)


STEPS = {"fence": fence, "open": open_, "repoint": repoint, "rejoin": rejoin}
