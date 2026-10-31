"""The fences of a production cluster move: one writer at any moment (OPS-1-am-a, hosting K21).

Pure: decides from listings and figures, runs nothing. Two clusters holding the
same data each send, because every dedupe table lives in its own database: a
bot's message, a notice, a charge, a WAL segment into the same S3 stanza.
"""
import datetime
import ipaddress
import json
import os

NAMESPACES = ("txnet", "txnet-monitoring")
# The three stores stay up on the old cluster until its bundle is made (move_plan.DATA_SERVICES).
STORES = ("main-db", "memory-data", "rabbitmq")
# Host timers on the old server that reach outside: the nightly bundle and the
# ship write to the same S3 bucket the new server writes to (bundle_timers.UNITS).
HOST_TIMERS = ("txnet-backup.timer", "txnet-backup-ship.timer")
# On the old server after the fence; prod.k8s.sh refuses to deploy beside it.
MOVED_MARKER = "/etc/txnet/moved-to"
# The live site's domain: never repointed without the user's word (ADR-0165).
LIVE_DOMAIN = "mytxnet.ir"
LIVE_DOMAIN_OK = "MOVE_LIVE_DOMAIN_OK"
# Set by staging.sh, whose restore scrubs (R16): a move restores production whole.
STAGING_ENV = "NODE_EXEC"
MUTE_TABLE = "txnet_move_mute"

# A rehearsal reads production's newest bundle and never touches the old cluster.
STEPS = {
    "rehearse": ("check", "mute", "install", "deploy", "bundle", "restore"),
    "move": ("check", "mute", "install", "deploy", "stop", "bundle", "restore",
             "fence", "open", "repoint", "rejoin"),
}


class MoveError(Exception):
    """Stops the move; the message says what state both clusters are in."""


def writers_left(pods_json, keep=STORES):
    """`kubectl get pods -A -o json` -> "namespace/pod" of every live pod that is not a kept store."""
    left = []
    for item in json.loads(pods_json)["items"]:
        meta = item["metadata"]
        if meta["namespace"] not in NAMESPACES or item["status"].get("phase") in ("Succeeded", "Failed"):
            continue
        owners = meta.get("ownerReferences") or []
        # the log shipper (a DaemonSet) sends only to Loki inside; it cannot scale and stops with k3s
        if any(o["kind"] == "DaemonSet" or (o["kind"] == "StatefulSet" and o["name"] in keep) for o in owners):
            continue
        left.append("%s/%s" % (meta["namespace"], meta["name"]))
    return sorted(left)


def stale_bundle(created, stop_at):
    """A refusal when the bundle's manifest `created` (UTC) is before the stop, else None."""
    made = datetime.datetime.strptime(created, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=datetime.timezone.utc)
    if made.timestamp() < stop_at:
        return "the bundle (%s) is older than the stop: what was written after it would be lost" % created
    return None


def restore_argv(root, bundle, passphrase):
    """B10's restore over the new cluster's seeded data; never --scrub (that is staging's, R16)."""
    return ["python3", os.path.join(root, "scripts/bundle/backup.py"), "--stack", "k8s",
            "restore", bundle, "--replace", "--passphrase-file", passphrase]


def refuse_scrub(env):
    if env.get(STAGING_ENV):
        return "%s is set: this is staging, whose restore scrubs; a move restores production whole" % STAGING_ENV
    return None


def refuse_live_domain(domain, env):
    if domain == LIVE_DOMAIN and env.get(LIVE_DOMAIN_OK) != LIVE_DOMAIN:
        return "%s is the live site: set %s=%s only on the user's word" % (LIVE_DOMAIN, LIVE_DOMAIN_OK, LIVE_DOMAIN)
    return None


def _addresses(values, what):
    try:
        return [str(ipaddress.ip_address(v)) for v in values]
    except ValueError as err:
        raise MoveError("%s: %s (an address, never a name: a name resolves anew)" % (what, err)) from err


def mute_ruleset(allowed, resolvers):
    """nft text that drops everything leaving this server, the host's and the pods', but
    replies, the allowed addresses (the registry) and DNS to the resolvers."""
    allowed = _addresses(allowed, "allowed")
    resolvers = _addresses(resolvers, "resolvers")
    rules = ["ct state established,related accept", "oifname \"lo\" accept",
             # the cluster's own pod and service ranges (k3s defaults) and private links
             "ip daddr { 10.0.0.0/8, 127.0.0.0/8 } accept"]
    if allowed:
        rules.append("ip daddr { %s } tcp dport 443 accept" % ", ".join(allowed))
    if resolvers:
        rules.append("ip daddr { %s } udp dport 53 accept" % ", ".join(resolvers))
        rules.append("ip daddr { %s } tcp dport 53 accept" % ", ".join(resolvers))

    def chain(name, hook):
        # before k3s's own filter rules; a drop here is final whatever they accept
        body = "\n".join("    " + r for r in rules)
        return "  chain %s {\n    type filter hook %s priority -10; policy drop;\n%s\n  }" % (name, hook, body)

    return "table inet %s {\n%s\n%s\n}\n" % (MUTE_TABLE, chain("mute_out", "output"), chain("mute_forward", "forward"))


def out_of_order(state, step):
    """A refusal when `step` may not run now, else None."""
    steps = STEPS[state["mode"]]
    if step not in steps:
        return "a rehearsal never runs `%s`: it reads production and changes nothing there" % step
    index = steps.index(step)
    missing = [s for s in steps[:index] if s not in state["done"]]
    if missing:
        return "`%s` comes after `%s`, which has not run" % (step, missing[0])
    return None


def not_fenced(evidence, new_address):
    """A refusal unless the old server, read just now, runs no k3s and carries the marker naming the new one."""
    if evidence.get("k3s") != "inactive":
        return "k3s on the old server is %s, not inactive" % evidence.get("k3s")
    if evidence.get("marker", "").strip() != new_address:
        return "the old server's marker %s does not name %s" % (MOVED_MARKER, new_address)
    return None
