"""The backup bundle on Kubernetes: made, restored and shipped through kubectl and claims (OPS-1-o-k).

The same answers bundle_stack.ComposeStack gives, from the cluster: a command
runs in a workload's container (`kubectl exec`), a throwaway pod stands in for a
throwaway container, a volume is its claim mounted in one, and the platform
stops by scaling to zero. The model is the one the renderer reads (K2), from the
sealed secrets opened in /dev/shm when the checkout has them (S4).
"""
import contextlib
import json
import os
import re
import secrets
import shlex
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import bundle_io as bio
import bundle_plan as bp
import bundle_stack as bs
import move_figures as mf
import move_hosts as mh
import move_plan as mp

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "tools"))
import k8s_render  # noqa: E402
import k8s_secrets  # noqa: E402
from k8srender.objects import dns_name  # noqa: E402
from k8srender.sealed import SEALED_DIR, sealed_path  # noqa: E402
from k8srender.tables import NAMESPACE, SIDECARS, STACKS, STATEFUL  # noqa: E402

PART_OF = "app.kubernetes.io/part-of=txnet"
# What a workload ran before a restore scaled it to zero. On the workload, so a
# restore that failed half-way and is run again still knows; removed at the start.
REPLICAS_BEFORE = "txnet.io/replicas-before-restore"
WAIT_TIMEOUT = "600s"
# A scratch pod's image is already on the node (K14), so Ready is a start, not a pull.
SCRATCH_READY_TIMEOUT = "300s"
SCRATCH_CONTAINER = "box"
PORT_FORWARD_WAIT_S = 30
_FORWARDING = re.compile(r"^Forwarding from 127\.0\.0\.1:(\d+) ->")


def workload(service):
    """(kubectl target, container) for a compose service: a sidecar rides in its owner's pod (K3)."""
    owner = SIDECARS.get(service, service)
    kind = "statefulset" if owner in STATEFUL else "deployment"
    return "%s/%s" % (kind, dns_name(owner)), dns_name(service)


def parse_replicas(listing):
    """`kubectl get deployments,statefulsets -o json` -> {"kind/name": replicas before any restore}."""
    def before(item):
        recorded = (item["metadata"].get("annotations") or {}).get(REPLICAS_BEFORE)
        return int(recorded) if recorded is not None else item["spec"].get("replicas", 1)
    return {"%s/%s" % (item["kind"].lower(), item["metadata"]["name"]): before(item)
            for item in json.loads(listing)["items"]}


def parse_selectors(listing):
    """The same listing -> {"kind/name": its pods' label selector}."""
    return {"%s/%s" % (item["kind"].lower(), item["metadata"]["name"]):
            ",".join("%s=%s" % pair for pair in sorted(item["spec"]["selector"]["matchLabels"].items()))
            for item in json.loads(listing)["items"]}


def forwarded_port(line):
    """The local port in kubectl port-forward's first line, or None."""
    found = _FORWARDING.match(line.strip())
    return int(found.group(1)) if found else None


def scratch_pod(name, image, command, args, env=None, claim=None, host_dir=None, node=None):
    """A throwaway pod: never part of the release (K10's prune and the stop never
    select it), no API token, a claim at /data or a host directory read-only."""
    container = {"name": SCRATCH_CONTAINER, "image": image, "imagePullPolicy": "IfNotPresent",
                 "command": command, "args": args,
                 "env": [{"name": k, "value": v} for k, v in sorted((env or {}).items())]}
    spec = {"restartPolicy": "Never", "terminationGracePeriodSeconds": 1,
            "automountServiceAccountToken": False, "containers": [container]}
    if claim:
        spec["volumes"] = [{"name": "data", "persistentVolumeClaim": {"claimName": claim}}]
        container["volumeMounts"] = [{"name": "data", "mountPath": "/data"}]
    if host_dir:
        # a host path is on one node: the pod goes where the files are
        spec["nodeName"] = node
        spec["volumes"] = [{"name": "host", "hostPath": {"path": host_dir[0], "type": "Directory"}}]
        container["volumeMounts"] = [{"name": "host", "mountPath": host_dir[1], "readOnly": True}]
    return {"apiVersion": "v1", "kind": "Pod",
            "metadata": {"name": name, "labels": {"app.kubernetes.io/name": "txnet-bundle"}}, "spec": spec}


def key_digests(root, opened, paths):
    """{path: digest of this server's copy, None when it has none}. A file with a
    sealed copy is that copy, opened: the render reads only it (S4), and a
    plaintext beside it may be stale. `opened` is None when nothing is sealed."""
    here = {}
    for path in paths:
        if opened and not os.path.isabs(path) and os.path.isfile(os.path.join(root, sealed_path(path))):
            if not os.path.exists(os.path.join(opened, path)):
                k8s_secrets.open_files(Path(root), [path], Path(opened))
            here[path] = bio.path_digest(os.path.join(opened, path))
        else:
            here[path] = bio.path_digest(os.path.join(root, path))
    return here


class K8sStack(mh.Host):
    """The platform in namespace txnet, reached with KUBECTL (default `kubectl`)."""

    MIGRATE_HINT = "`scripts/prod.k8s.sh deploy` again, whose db-migrate brings the schema up (K8)"

    def __init__(self, root):
        super().__init__(root, "k8s")
        self.kubectl = shlex.split(os.environ.get("KUBECTL", "kubectl")) + ["-n", NAMESPACE]
        self.opened = None
        self.workloads = {}

    def close(self):
        """Removes the opened secrets; every caller ends with it."""
        if self.opened:
            shutil.rmtree(self.opened, ignore_errors=True)
            self.opened = None

    def env_files(self):
        """The main stack's env files: the sealed copies, opened once, when the checkout has them."""
        names = STACKS["main"].env_files
        sealed = os.path.join(self.root, SEALED_DIR)
        if not any(f.endswith(".sops") for _, _, files in os.walk(sealed) for f in files):
            return list(names)
        if not self.opened:
            self.opened = tempfile.mkdtemp(prefix="txnet-secrets.", dir="/dev/shm")
            self.run([sys.executable, os.path.join(self.root, "tools", "k8s_secrets.py"), "open", self.opened])
        return [os.path.join(self.opened, f) for f in names]

    def config(self):
        return k8s_render.load_model(STACKS["main"], self.env_files(), {})

    def kube(self, *args, stdin=None):
        return self.run(self.kubectl + list(args), stdin=stdin)

    def exec_argv(self, service, *args):
        target, container = workload(service)
        return self.kubectl + ["exec", "-i", target, "-c", container, "--", *args]

    def service_box(self, service):
        """A running workload's container as a Box, to put files in and run them there."""
        target, container = workload(service)
        return bs.Box(self, self.exec_argv(service), self.kubectl + ["logs", target, "-c", container])

    def image(self, service):
        """The image the cluster runs for service: the release's, not the checkout's."""
        target, container = workload(service)
        return self.kube("get", target, "-o", 'jsonpath={.spec.template.spec.containers[?(@.name=="%s")].image}'
                         % container).strip()

    def node_name(self):
        nodes = self.kube("get", "nodes", "-o", "name").split()
        return nodes[0].split("/", 1)[1] if len(nodes) == 1 else socket.gethostname()

    @contextlib.contextmanager
    def scratch(self, image, command=None, env=None, volume=None, host_dir=None, network=False):
        """A throwaway pod; `volume` is a compose volume key, mounted as its claim (K7).
        Pods always have a network; what runs in one listens on no address (drill) or loopback."""
        name = "txnet-bundle-" + secrets.token_hex(4)
        command = command or bs.IDLE
        pod = scratch_pod(name, image, command[:1], command[1:], env, dns_name(volume) if volume else None,
                          host_dir, self.node_name() if host_dir else None)
        self.kube("apply", "-f", "-", stdin=json.dumps(pod))
        try:
            self.kube("wait", "--for=condition=Ready", "pod/" + name, "--timeout=" + SCRATCH_READY_TIMEOUT)
            yield bs.Box(self, self.kubectl + ["exec", "-i", name, "-c", SCRATCH_CONTAINER, "--"],
                      self.kubectl + ["logs", name])
        finally:
            subprocess.run(self.kubectl + ["delete", "pod", name, "--ignore-not-found", "--wait=true"],
                           capture_output=True)

    def pack_volume(self, key, archive):
        with self.scratch(self.image("main-db"), volume=key) as box:
            self.run_to_file(box.exec_argv("tar", "-C", "/data", "--numeric-owner", "-cf", "-", "."), archive)

    def unpack_volume(self, key, archive):
        # put whole and counted first (Box.put), never streamed into tar's stdin
        with self.scratch(self.image("main-db"), volume=key) as box:
            box.put(archive, "/tmp/volume.tar")
            self.run(box.exec_argv("sh", "-c", "find /data -mindepth 1 -delete && "
                                   "tar -C /data --numeric-owner -xpf /tmp/volume.tar && rm /tmp/volume.tar"))

    def empty_volume(self, key):
        with self.scratch(self.image("main-db"), volume=key) as box:
            self.run(box.exec_argv("find", "/data", "-mindepth", "1", "-delete"))

    @contextlib.contextmanager
    def management_url(self, port):
        """RabbitMQ's management API through `kubectl port-forward` on this host's loopback."""
        target, _ = workload("rabbitmq")
        forward = subprocess.Popen(self.kubectl + ["port-forward", target, "0:%d" % port],
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        try:
            deadline = time.monotonic() + PORT_FORWARD_WAIT_S
            local = None
            while local is None and time.monotonic() < deadline:
                line = forward.stdout.readline()
                if not line:
                    raise RuntimeError("port-forward to rabbitmq ended: %s" % forward.stderr.read().strip())
                local = forwarded_port(line)
            if local is None:
                raise RuntimeError("port-forward to rabbitmq did not start in %ds" % PORT_FORWARD_WAIT_S)
            yield "http://127.0.0.1:%d/api/" % local
        finally:
            forward.terminate()
            forward.wait(timeout=10)

    def holds_data(self):
        """Users in the main database: db-migrate seeds rows into every deployed cluster, never users.
        A restore that failed after its stop left the stores at zero; they come up to be asked."""
        if self.kube("get", workload("main-db")[0], "-o", "jsonpath={.spec.replicas}").strip() == "0":
            self.start_data()
        sql = 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atq'
        return bp.holds_users(mf.parse_counts(self.run(self.exec_argv("main-db", "sh", "-c", sql),
                                                       stdin=mf.TABLE_COUNTS_SQL + ";\n")))

    def prepare(self, say):
        """The node pulls; it never builds (K14): the release must already be deployed."""
        try:
            self.kube("get", workload("main-db")[0])
        except RuntimeError:
            raise RuntimeError("the cluster has no main-db: `scripts/prod.k8s.sh deploy` at the bundle's commit first")
        say("the cluster runs its release's images (K14); nothing to build")

    def _listing(self):
        return self.kube("get", "deployments,statefulsets", "-l", PART_OF, "-o", "json")

    def stop_all(self):
        """Every workload to zero, its replicas kept for start_all, and waited until its pods are gone."""
        listing = self._listing()
        self.workloads = parse_replicas(listing)
        for target, replicas in sorted(self.workloads.items()):
            self.kube("annotate", "--overwrite", target, "%s=%d" % (REPLICAS_BEFORE, replicas))
            self.kube("scale", target, "--replicas=0")
        for selector in parse_selectors(listing).values():
            self.kube("wait", "--for=delete", "pod", "-l", selector, "--timeout=" + WAIT_TIMEOUT)

    def _scale_up(self, targets):
        for target in targets:
            self.kube("scale", target, "--replicas=%d" % max(self.workloads.get(target, 1), 1))
        for target in targets:
            self.kube("rollout", "status", target, "--timeout=" + WAIT_TIMEOUT)
            self.kube("annotate", target, REPLICAS_BEFORE + "-")

    def start_data(self):
        self._scale_up([workload(s)[0] for s in mp.DATA_SERVICES])

    def start_all(self):
        data = {workload(s)[0] for s in mp.DATA_SERVICES}
        self._scale_up([t for t, n in sorted(self.workloads.items()) if n > 0 and t not in data])
        for target in sorted(t for t, n in self.workloads.items() if n == 0):
            self.kube("annotate", target, REPLICAS_BEFORE + "-")  # stopped before the restore too

    def login_roles(self):
        """R11's login roles, as `prod.k8s.sh deploy` makes them, with this cluster's passwords."""
        self.env_files()
        self.run(["env", "ENV_DIR=" + (self.opened or self.root), "ENV_FILE=.env.prod",
                  "DB_EXEC=" + shlex.join(self.exec_argv("main-db")), os.path.join(self.root, "scripts", "db-login-roles.sh")])

    def key_digest(self, path):
        self.env_files()
        return key_digests(self.root, self.opened, [path])[path]

    def start_full_backup(self):
        # in the background, logging where pg-backup's loop logs: kubectl exec has no -d
        self.run(self.exec_argv("pg-backup", "sh", "-c", "nohup sh /usr/local/bin/pg-backup.sh full >/proc/1/fd/1 2>&1 &"))

    def has_service(self, service):
        return service in self.config()["services"]

