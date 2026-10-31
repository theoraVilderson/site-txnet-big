#!/usr/bin/env python3
"""A release that rolls back as one (ADR-0164 point 2, hosting K16, contract.release.md R5–R9).

    python3 tools/k8s_release.py smoke <manifest> --sealed DIR [--kubectl K]
                                         ask every container's probe and every IngressRoute once (R6)
    python3 tools/k8s_release.py history deploy|rollback <tag> [history...]
                                         the release record after a deploy or a rollback (R8)
    python3 tools/k8s_release.py current|previous [history...]
                                         what runs now, and what `rollback` with no tag goes back to

`scripts/prod.k8s.sh` calls these; the record itself is ConfigMap `txnet-release`.
"""
import argparse
import re
import select
import socket
import subprocess
import sys
import time
from pathlib import Path
from typing import NamedTuple

import yaml

sys.path.insert(0, str(Path(__file__).parent))
from k8srender.sealed import ORIGIN_PULL_CLIENT_DIR, ORIGIN_PULL_CLIENT_PAIR  # noqa: E402
from k8srender.tables import NAMESPACE, STACKS, TRAEFIK  # noqa: E402

# R8: enough to go back past a run of bad releases; the ConfigMap stays tiny.
HISTORY_KEPT = 10
# R22: the releases whose images the registry keeps, so the ones a rollback reaches.
IMAGES_KEPT = 5
# Traefik's entrypoints inside its pod (compose/edge.yml); the forward reaches them there.
_DOORS = {"http": 80, "https": 443}
_SECURE_ENTRYPOINT = "websecure"
_FORWARD_READY_S = 30
_FORWARD_TRIES = 3  # a forward that ends is retried; one the API never answers is not
_REQUEST_TIMEOUT_S = 15
_EXEC_GRACE_S = 10  # kubectl's own round trip on top of the probe's timeout
_SERVER_ERROR = 500
_WORKLOADS = ("Deployment", "StatefulSet", "DaemonSet")
_MATCHER = re.compile(r"\b(Host|HostRegexp|PathPrefix|Path|Method)\(`([^`]*)`\)")


class Exec(NamedTuple):
    """One container's own health, asked with its probe's command."""
    namespace: str
    target: str
    container: str
    argv: list
    timeout: int
    # The probe's own patience: the kubelet calls a container unhealthy only after
    # failureThreshold failures periodSeconds apart (Kubernetes' defaults below).
    attempts: int = 3
    period: int = 10


class Request(NamedTuple):
    """One request aimed at one IngressRoute through Traefik."""
    route: str
    scheme: str
    host: str
    path: str
    method: str


def _namespace(obj: dict) -> str:
    return obj["metadata"].get("namespace", NAMESPACE)


def _running(obj: dict) -> bool:
    return obj["spec"].get("replicas", 1) != 0


def health_checks(objects: list) -> list[Exec]:
    """Each running workload's containers, by readiness probe or, for a sidecar, liveness (K6)."""
    checks = []
    for obj in objects:
        if obj["kind"] not in _WORKLOADS or not _running(obj):
            continue
        for container in obj["spec"]["template"]["spec"]["containers"]:
            probe = container.get("readinessProbe") or container.get("livenessProbe") or {}
            if "exec" in probe:
                checks.append(Exec(_namespace(obj), f"{obj['kind'].lower()}/{obj['metadata']['name']}",
                                   container["name"], probe["exec"]["command"], probe.get("timeoutSeconds", 1),
                                   probe.get("failureThreshold", 3), probe.get("periodSeconds", 10)))
    return checks


def route_requests(objects: list, api_host: str) -> list[Request]:
    """One request per IngressRoute: its first Host, first path and method, on its
    secure door when it has one. A route naming no host gets `api_host`, which only
    `/api/bot` names: on the apex coinsite's longer rule would win the request.
    A route to a workload at zero replicas is left out: its 503 is the overlay's choice."""
    stopped = {(_namespace(o), o["metadata"]["name"]) for o in objects
               if o["kind"] in _WORKLOADS and not _running(o)}
    requests = []
    for obj in objects:
        if obj["kind"] != "IngressRoute":
            continue
        first = obj["spec"]["routes"][0]
        backend = (first.get("services") or [{}])[0].get("name")
        if (_namespace(obj), backend) in stopped:
            continue
        found = {}
        for matcher, value in _MATCHER.findall(first["match"]):
            found.setdefault(matcher, value)
        doors = obj["spec"].get("entryPoints") or []
        secure = _SECURE_ENTRYPOINT in doors or (not doors and "tls" in obj["spec"])
        requests.append(Request(f"{_namespace(obj)}/{obj['metadata']['name']}", "https" if secure else "http",
                                found.get("Host", api_host), found.get("PathPrefix") or found.get("Path", "/"),
                                found.get("Method", "GET")))
    return requests


def curl_argv(request: Request, ports: dict, client_dir: Path) -> list[str]:
    """curl through the local forward to Traefik, by the route's own host name (SNI and
    Host), printing only the status code."""
    port = ports[request.scheme]
    argv = ["curl", "--noproxy", "*", "-sk", "-o", "/dev/null", "-w", "%{http_code}",
            "--max-time", str(_REQUEST_TIMEOUT_S), "-X", request.method,
            "--resolve", f"{request.host}:{port}:127.0.0.1"]
    if request.scheme == "https":
        cert, key = ORIGIN_PULL_CLIENT_PAIR
        argv += ["--cert", str(client_dir / cert), "--key", str(client_dir / key)]
    return argv + [f"{request.scheme}://{request.host}:{port}{request.path}"]


def passed(status: str) -> bool:
    """Any answer below 500 is a live route: a 401 or 404 still came from its backend.
    000 is no answer at all."""
    return status.isdigit() and 0 < int(status) < _SERVER_ERROR


def after_deploy(history: list[str], tag: str) -> list[str]:
    return ([t for t in history if t != tag] + [tag])[-HISTORY_KEPT:]


def after_rollback(history: list[str], tag: str) -> list[str]:
    """Back to `tag`: the releases after it are undone and forgotten, so the next
    `rollback` goes further back, never forward again."""
    return history[:history.index(tag) + 1] if tag in history else after_deploy(history, tag)


def current(history: list[str]) -> str:
    return history[-1] if history else ""


def previous(history: list[str]) -> str:
    return history[-2] if len(history) > 1 else ""


def restorable(history: list[str], tag: str) -> bool:
    """R22: `tag` is one of the last IMAGES_KEPT releases, whose images the registry still holds."""
    return tag in history[-IMAGES_KEPT:]


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _forward_once(kubectl: str) -> tuple[subprocess.Popen | None, dict, str]:
    """One `kubectl port-forward` to Traefik's pod: (the process once both doors
    listen, or None, its ports, what kubectl said)."""
    ports = {scheme: _free_port() for scheme in _DOORS}
    proc = subprocess.Popen([kubectl, "-n", NAMESPACE, "port-forward", f"deployment/{TRAEFIK}",
                             *(f"{ports[s]}:{_DOORS[s]}" for s in _DOORS)],
                            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
    said, listening = [], 0
    while listening < len(_DOORS):
        line = proc.stdout.readline() if select.select([proc.stdout], [], [], _FORWARD_READY_S)[0] else ""
        if not line:  # ended, or silent for _FORWARD_READY_S
            proc.kill()
            return None, ports, "".join(said).strip() or f"nothing in {_FORWARD_READY_S}s"
        said.append(line)
        listening += line.startswith("Forwarding from 127.0.0.1")
    return proc, ports, ""


def forward(kubectl: str) -> tuple[subprocess.Popen, dict]:
    """`kubectl port-forward` to Traefik's pod, waited on until both doors listen.
    A forward that ends is the check's tool failing, not the release (OPS-1-o-f):
    tried again on fresh ports, then failed with kubectl's own words."""
    said = []
    for _ in range(_FORWARD_TRIES):
        proc, ports, why = _forward_once(kubectl)
        if proc:
            return proc, ports
        said.append(why)
    raise RuntimeError(f"port-forward to {TRAEFIK} did not listen in {_FORWARD_TRIES} tries: " + " | ".join(said))


def _api_host(sealed: Path) -> str:
    """`api.${DOMAIN_NAME}`, the platform's own API host (bot-service calls it), with
    DOMAIN_NAME as compose reads it from the opened env files (K2)."""
    import k8s_render
    stack = STACKS["main"]
    variables = k8s_render.compose(stack, ["--environment"], [str(sealed / f) for f in stack.env_files], {})
    return "api." + dict(line.split("=", 1) for line in variables.splitlines() if "=" in line)["DOMAIN_NAME"]


def healthy(check: Exec, kubectl: str, run=subprocess.run, sleep=time.sleep) -> bool:
    """The probe asked as the kubelet asks it: unhealthy only after `attempts`
    failures in a row. Asked once, a single slow answer at load 9 on the staging
    twin set a Ready release back (OPS-1-ah-c, 2026-10-29)."""
    for attempt in range(check.attempts):
        if attempt:
            sleep(check.period)
        try:
            if run([kubectl, "-n", check.namespace, "exec", check.target, "-c", check.container, "--", *check.argv],
                   capture_output=True, timeout=check.timeout + _EXEC_GRACE_S).returncode == 0:
                return True
        except subprocess.TimeoutExpired:
            pass
    return False


def smoke(manifest: Path, sealed: Path, kubectl: str) -> bool:
    objects = [o for o in yaml.safe_load_all(manifest.read_text()) if o]
    ok = True
    for check in health_checks(objects):
        fine = healthy(check, kubectl)
        ok &= fine
        print(f"{'ok  ' if fine else 'FAIL'}  health {check.target} {check.container}")
    proc, ports = forward(kubectl)
    try:
        for request in route_requests(objects, _api_host(sealed)):
            status = subprocess.run(curl_argv(request, ports, sealed / ORIGIN_PULL_CLIENT_DIR),
                                    capture_output=True, text=True).stdout.strip() or "000"
            ok &= passed(status)
            print(f"{'ok  ' if passed(status) else 'FAIL'}  {status} {request.route} "
                  f"{request.method} {request.scheme}://{request.host}{request.path}")
    finally:
        proc.terminate()
        proc.wait()
    return ok


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("command", choices=("smoke", "history", "current", "previous", "restorable"))
    parser.add_argument("args", nargs="*")
    parser.add_argument("--sealed", type=Path, help="smoke: the opened sealed secrets (K5)")
    parser.add_argument("--kubectl", default="kubectl")
    args = parser.parse_args()
    if args.command == "smoke":
        if len(args.args) != 1 or not args.sealed:
            parser.error("smoke <manifest> --sealed DIR")
        return 0 if smoke(Path(args.args[0]), args.sealed, args.kubectl) else 1
    if args.command == "history":
        if len(args.args) < 2 or args.args[0] not in ("deploy", "rollback"):
            parser.error("history deploy|rollback <tag> [history...]")
        step = after_deploy if args.args[0] == "deploy" else after_rollback
        print(" ".join(step(args.args[2:], args.args[1])))
        return 0
    if args.command == "restorable":
        return 0 if args.args and restorable(args.args[1:], args.args[0]) else 1
    print((current if args.command == "current" else previous)(args.args))
    return 0


if __name__ == "__main__":
    sys.exit(main())
