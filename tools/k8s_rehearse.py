#!/usr/bin/env python3
"""The rehearsal's proof on the k3s node (hosting K12, ADR-0163, OPS-1-o-f).

    python3 tools/k8s_rehearse.py ready     every workload in txnet and txnet-monitoring ready
    python3 tools/k8s_rehearse.py roll      billing-service rolled under a request loop: no answer >= 500
    python3 tools/k8s_rehearse.py stores    a row, a key and a message survive main-db's Postgres
                                            killed and each data store's pod deleted
    python3 tools/k8s_rehearse.py drill     pg-backup.sh drill in main-db's pod
    python3 tools/k8s_rehearse.py bundle    a bundle made, a later row written, the bundle restored:
                                            the first row is back and the later one gone (B10)
    python3 tools/k8s_rehearse.py check     all five, in that order

Run as root on the node, from the repo, by `scripts/k8s-rehearse.sh check`.
Requests go to the node's own address (`--address`, default HOST_GATEWAY), the
door Cloudflare reaches, through Traefik's LoadBalancer. The markers it writes
are removed at the end; the rehearsal's cluster is emptied before OPS-1-p.
"""
import argparse
import base64
import json
import os
import re
import secrets
import shlex
import subprocess
import sys
import threading
import time
import urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "scripts" / "bundle"))
sys.path.insert(0, str(ROOT / "scripts" / "move"))
import k8s_release  # noqa: E402
from bundle_k8s import K8sStack, workload  # noqa: E402
from k8srender.tables import NAMESPACE  # noqa: E402

MONITORING_NAMESPACE = "txnet-monitoring"
# K12: the Deployment the rolling update is proven on.
ROLLED = "billing-service"
STORES = ("main-db", "memory-data", "rabbitmq")
WAIT_TIMEOUT = "300s"  # K10's rollout timeout
# Requests in flight during the roll: enough that a gap of one pod is met, few
# enough that the node's other workloads are not starved (ADR-0163 point 5).
LOAD_WORKERS = 4
# After `rollout status`, the old pod still drains: compose's 10s grace plus the
# endpoint removal's propagation.
DRAIN_TAIL_S = 20
RESTART_WAIT_S = 120
MARKER_TABLE = "public.k8s_rehearsal"
MARKER_KEY = "txnet:k8s-rehearsal"
MARKER_QUEUE = "k8s-rehearsal"
PERSISTENT = 2  # AMQP delivery_mode
HTTP_NOT_FOUND = 404
_BUNDLE_PATH = re.compile(r"^backup: (/\S+) \(\d+ MB, \d+s\)$")


def say(message):
    print("rehearse: " + message, flush=True)


def kubectl():
    return shlex.split(os.environ.get("KUBECTL", "kubectl"))


def kube(*args, check=True):
    return subprocess.run(kubectl() + list(args), check=check, capture_output=True, text=True).stdout


# --- ready ---------------------------------------------------------------

def not_ready(listing: dict) -> list[str]:
    """`kubectl get deploy,sts,ds -o json` -> each workload whose ready count is
    short of what it asks for. A workload at zero replicas is the overlay's choice."""
    short = []
    for item in listing["items"]:
        spec, status = item["spec"], item.get("status", {})
        if item["kind"] == "DaemonSet":
            wanted, ready = status.get("desiredNumberScheduled", 0), status.get("numberReady", 0)
        else:
            wanted, ready = spec.get("replicas", 1), status.get("readyReplicas", 0)
        if ready < wanted:
            short.append(f"{item['metadata']['namespace']}/{item['kind'].lower()}/{item['metadata']['name']}"
                         f" {ready}/{wanted}")
    return short


def check_ready():
    listing = {"items": []}
    for namespace in (NAMESPACE, MONITORING_NAMESPACE):
        listing["items"] += json.loads(kube("-n", namespace, "get", "deploy,sts,ds", "-o", "json"))["items"]
    short = not_ready(listing)
    for line in short:
        say("not ready: " + line)
    say(f"{len(listing['items'])} workloads, {len(listing['items']) - len(short)} ready")
    return not short


# --- roll ----------------------------------------------------------------

def routes_to(objects: list, service: str, api_host: str) -> list:
    """The smoke check's requests (R6) for the IngressRoutes whose first route ends at `service`."""
    mine = [o for o in objects if o["kind"] == "IngressRoute"
            and (o["spec"]["routes"][0].get("services") or [{}])[0].get("name") == service]
    return k8s_release.route_requests(mine, api_host)


def failed(statuses: Counter) -> int:
    """Answers that are not a live route's (k8s_release.passed): a 5xx, or no answer."""
    return sum(n for status, n in statuses.items() if not k8s_release.passed(status))


class Load:
    """LOAD_WORKERS threads asking `requests` in turn until stopped, counting each status."""

    def __init__(self, requests, argv_for):
        self.requests, self.argv_for = requests, argv_for
        self.statuses, self.lock, self.done = Counter(), threading.Lock(), threading.Event()
        self.threads = [threading.Thread(target=self._ask, args=(i,), daemon=True) for i in range(LOAD_WORKERS)]

    def _ask(self, offset):
        turn = offset
        while not self.done.is_set():
            request = self.requests[turn % len(self.requests)]
            out = subprocess.run(self.argv_for(request), capture_output=True, text=True).stdout.strip() or "000"
            with self.lock:
                self.statuses[out] += 1
            turn += 1

    def __enter__(self):
        for thread in self.threads:
            thread.start()
        return self

    def __exit__(self, *exc):
        self.done.set()
        for thread in self.threads:
            thread.join()


def check_roll(address, sealed_dir):
    objects = json.loads(kube("-n", NAMESPACE, "get", "ingressroute", "-o", "json"))["items"]
    requests = routes_to(objects, ROLLED, k8s_release._api_host(sealed_dir))
    if not requests:
        say(f"no IngressRoute ends at {ROLLED}")
        return False
    client_dir = sealed_dir / k8s_release.ORIGIN_PULL_CLIENT_DIR
    ports = {"http": 80, "https": 443}

    def argv_for(request):
        argv = k8s_release.curl_argv(request, ports, client_dir)
        return [a.replace("127.0.0.1", address) for a in argv[:-1]] + [argv[-1]]

    with Load(requests, argv_for) as load:
        time.sleep(DRAIN_TAIL_S)  # a baseline before the roll
        kube("-n", NAMESPACE, "rollout", "restart", f"deployment/{ROLLED}")
        kube("-n", NAMESPACE, "rollout", "status", f"deployment/{ROLLED}", f"--timeout={WAIT_TIMEOUT}")
        time.sleep(DRAIN_TAIL_S)
    total, bad = sum(load.statuses.values()), failed(load.statuses)
    say(f"roll {ROLLED}: {total} requests, {bad} failed, by status {dict(load.statuses)}")
    return total > 0 and bad == 0


# --- stores --------------------------------------------------------------

class Markers:
    """One row, one key and one queued message, each written and read back through its store."""

    def __init__(self, stack: K8sStack):
        self.stack = stack

    def sh(self, service, script, stdin=None):
        return self.stack.run(self.stack.exec_argv(service, "sh", "-c", script), stdin=stdin)

    def sql(self, statement):
        return self.sh("main-db", 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atq -v ON_ERROR_STOP=1',
                       stdin=statement + "\n").strip()

    def write_row(self, token):
        self.sql(f"CREATE TABLE IF NOT EXISTS {MARKER_TABLE} (token text PRIMARY KEY); "
                 f"INSERT INTO {MARKER_TABLE} VALUES ('{token}');")

    def has_row(self, token):
        return self.sql(f"SELECT count(*) FROM {MARKER_TABLE} WHERE token = '{token}';") == "1"

    def redis(self, *args):
        # REDIS_PASSWORD is already in memory-data's env (K5); nothing reaches a command line
        return self.sh("memory-data", 'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --no-auth-warning ' +
                       " ".join(shlex.quote(a) for a in args)).strip()

    def mq(self, method, path, body=None):
        user, password = (self.stack.run(self.stack.exec_argv("rabbitmq", "printenv", name)).strip()
                          for name in ("RABBITMQ_DEFAULT_USER", "RABBITMQ_DEFAULT_PASS"))
        with self.stack.management_url(15672) as base:
            request = urllib.request.Request(base + path, method=method,
                                             data=None if body is None else json.dumps(body).encode(),
                                             headers={"content-type": "application/json", "Authorization": "Basic " +
                                                      base64.b64encode(f"{user}:{password}".encode()).decode()})
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
            with opener.open(request, timeout=10) as response:
                text = response.read()
        return json.loads(text) if text else {}

    def write(self, token):
        # A run that failed mid-step left its markers; a second queued message read as LOST.
        self.remove()
        self.write_row(token)
        self.redis("SET", MARKER_KEY, token)
        self.mq("PUT", f"queues/%2F/{MARKER_QUEUE}", {"durable": True})
        self.mq("POST", "exchanges/%2F/amq.default/publish",
                {"routing_key": MARKER_QUEUE, "payload": token, "payload_encoding": "string",
                 "properties": {"delivery_mode": PERSISTENT}})

    def read(self, token):
        """{store: found} for the three markers."""
        queued = self.mq("GET", f"queues/%2F/{MARKER_QUEUE}").get("messages", 0)
        return {"main-db": self.has_row(token), "memory-data": self.redis("GET", MARKER_KEY) == token,
                "rabbitmq": queued == 1}

    def remove(self):
        self.sql(f"DROP TABLE IF EXISTS {MARKER_TABLE};")
        self.redis("DEL", MARKER_KEY)
        try:
            self.mq("DELETE", f"queues/%2F/{MARKER_QUEUE}")
        except urllib.error.HTTPError as error:
            if error.code != HTTP_NOT_FOUND:  # no queue is what clean means
                raise


def restarts(pod, container):
    return int(kube("-n", NAMESPACE, "get", "pod", pod, "-o",
                    f'jsonpath={{.status.containerStatuses[?(@.name=="{container}")].restartCount}}') or 0)


def on_node(*argv):
    """argv run on the node: here, or through NODE_EXEC when the node is a
    container (staging, ADR-0166), whose crictl and pids are its own — on the dev
    host the host's k3s is a production agent and its pids are another namespace."""
    return [*shlex.split(os.environ.get("NODE_EXEC", "")), *argv]


def crictl(*argv):
    """crictl on the node: `k3s crictl` on a k3s host, CRICTL where it is its own
    binary (rancher/k3s, staging's node, has no `k3s crictl`)."""
    return on_node(*shlex.split(os.environ.get("CRICTL", "k3s crictl")), *argv)


def kill_postgres():
    """SIGKILL on the node, no shutdown at all: the container restarts in its pod
    and Postgres replays its WAL. Sent to the container's own pid: `crictl stop
    --timeout 0` also zeroes crictl 1.34's call deadline and failed half the time."""
    pod = workload("main-db")[0].split("/", 1)[1] + "-0"
    before = restarts(pod, "main-db")
    ids = subprocess.run(crictl("ps", "-q", "--name", "^main-db$", "--label",
                                 f"io.kubernetes.pod.name={pod}"), check=True, capture_output=True, text=True).stdout.split()
    for container in ids:
        pid = subprocess.run(crictl("inspect", "-o", "go-template", "--template", "{{.info.pid}}",
                                     container), check=True, capture_output=True, text=True).stdout.strip()
        subprocess.run(on_node("kill", "-KILL", pid), check=True)
    deadline = time.monotonic() + RESTART_WAIT_S
    while restarts(pod, "main-db") == before:
        if time.monotonic() > deadline:
            raise RuntimeError(f"{pod} did not restart main-db in {RESTART_WAIT_S}s")
        time.sleep(2)
    kube("-n", NAMESPACE, "wait", "--for=condition=Ready", f"pod/{pod}", f"--timeout={WAIT_TIMEOUT}")
    say(f"main-db killed and back ({pod}, restart {before + 1})")


def delete_store_pods():
    for store in STORES:
        target = workload(store)[0]
        kube("-n", NAMESPACE, "delete", "pod", target.split("/", 1)[1] + "-0", "--wait=true")
        kube("-n", NAMESPACE, "rollout", "status", target, f"--timeout={WAIT_TIMEOUT}")
        say(f"{store}'s pod deleted and back")


def report(found):
    for store, ok in found.items():
        say(f"{'ok  ' if ok else 'LOST'}  {store}")
    return all(found.values())


def check_stores(stack):
    markers, token = Markers(stack), secrets.token_hex(8)
    markers.write(token)
    try:
        kill_postgres()
        ok = markers.has_row(token)
        say(f"{'ok  ' if ok else 'LOST'}  main-db's row after the kill")
        delete_store_pods()
        return ok & report(markers.read(token))
    finally:
        markers.remove()


# --- drill, bundle -------------------------------------------------------

def check_drill(stack):
    run = subprocess.run(stack.exec_argv("pg-backup", "sh", "/usr/local/bin/pg-backup.sh", "drill"),
                         capture_output=True, text=True)
    print(run.stdout[-2000:] + run.stderr[-2000:], end="")
    say(f"drill {'passed' if run.returncode == 0 else 'FAILED'}")
    return run.returncode == 0


def bundle_path(output):
    """The file `backup.py now` reports making."""
    for line in output.splitlines():
        found = _BUNDLE_PATH.match(line.strip())
        if found:
            return found.group(1)
    raise RuntimeError("backup.py now named no bundle:\n" + output[-2000:])


def backup(*args):
    run = subprocess.run([sys.executable, str(ROOT / "scripts" / "bundle" / "backup.py"), "--stack", "k8s", *args],
                         capture_output=True, text=True, cwd=ROOT)
    print(run.stdout[-3000:] + run.stderr[-3000:], end="")
    if run.returncode:
        raise RuntimeError(f"backup.py {args[0]} failed ({run.returncode})")
    return run.stdout


def check_bundle(stack):
    markers, kept, later = Markers(stack), secrets.token_hex(8), secrets.token_hex(8)
    markers.write_row(kept)
    made = bundle_path(backup("now"))
    markers.write_row(later)
    backup("restore", made, "--replace")
    found = {"the bundle's row": markers.has_row(kept), "no later row": not markers.has_row(later)}
    markers.sql(f"DROP TABLE IF EXISTS {MARKER_TABLE};")
    return report(found)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["ready", "roll", "stores", "drill", "bundle", "check"])
    parser.add_argument("--address", default=os.environ.get("HOST_GATEWAY"), help="the node's public address")
    args = parser.parse_args(argv)
    stack = K8sStack(str(ROOT))
    try:
        steps = {"ready": check_ready,
                 "roll": lambda: check_roll(args.address, Path(stack.env_files()[0]).parent),
                 "stores": lambda: check_stores(stack), "drill": lambda: check_drill(stack),
                 "bundle": lambda: check_bundle(stack)}
        chosen = list(steps) if args.command == "check" else [args.command]
        if "roll" in chosen and not args.address:
            parser.error("--address or HOST_GATEWAY: the node's public address")
        results = {}
        for name in chosen:
            say(f"== {name}")
            results[name] = steps[name]()
            if not results[name]:
                break
        for name, ok in results.items():
            say(f"{'PASS' if ok else 'FAIL'}  {name}")
        return 0 if len(results) == len(chosen) and all(results.values()) else 1
    finally:
        stack.close()


if __name__ == "__main__":
    sys.exit(main())
