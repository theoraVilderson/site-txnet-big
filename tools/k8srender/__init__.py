"""Render the production compose model into a Kustomize base (ADR-0147, hosting K2-K7).

`render(model, repo, options)` takes what `docker compose config --format json`
prints and returns {file name: objects}; `tools/k8s_render.py` writes them.
"""
import re
from dataclasses import dataclass
from pathlib import Path

from .container import container, environment_secret, image_for
from .objects import RenderError, dns_name, seconds
from .tables import ALWAYS_RESTART, DROPPED_KEYS, SIDECARS, STATEFUL
from .volumes import Mounts

__all__ = ["RenderError", "render"]

NAMESPACE = "txnet"
PART_OF = {"app.kubernetes.io/part-of": "txnet"}
# K3: compose's stop grace when a service names none.
_DEFAULT_GRACE_S = 10
_MAPPED_KEYS = {"command", "entrypoint", "environment", "expose", "extra_hosts", "healthcheck", "image",
                "labels", "mem_limit", "cpus", "ports", "restart", "shm_size", "stop_grace_period",
                "tmpfs", "volumes", "working_dir"}
# K11: the compose label Promtail selects on, and the pod label it becomes.
_LOGGING_LABEL, _POD_LOGGING_LABEL = "txnet.logging", "txnet.io/logging"
# A `host:port` or `//host` inside an environment value (K4).
_HOST_REF = re.compile(r"(?:^|[/@,=\s])([a-z][a-z0-9-]*)(?::(\d+))?(?=[/:?,\s]|$)")


@dataclass(frozen=True)
class _Stack:
    """What every pod's rendering reads: the services, who builds which image, options."""
    services: dict
    builders: dict
    options: dict
    repo: Path


def render(model: dict, repo: Path, options: dict) -> dict:
    services = model["services"]
    for name, service in services.items():
        _check_keys(name, service)
    _check_calls(services)
    builders = {s["image"]: n for n, s in services.items() if s.get("build") and s.get("image")}
    stack = _Stack(services, builders, options, repo)
    files, shared = {}, {}
    for name in sorted(services):
        if name in SIDECARS:
            continue
        files[f"{name}.yaml"], mounted = _pod(stack, name)
        shared.update(mounted)
    files["storage.yaml"] = [o for k, o in sorted(shared.items()) if k.startswith("pvc/")]
    files["files.yaml"] = [o for k, o in sorted(shared.items()) if k.startswith("file/")]
    files["namespace.yaml"] = [{"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": NAMESPACE}}]
    files = {k: v for k, v in files.items() if v}
    files["kustomization.yaml"] = {
        "apiVersion": "kustomize.config.k8s.io/v1beta1", "kind": "Kustomization",
        "namespace": NAMESPACE, "resources": sorted(files),
        "labels": [{"pairs": PART_OF, "includeSelectors": False}],
    }
    return files


def _pod(stack: _Stack, name: str) -> tuple[list, dict]:
    """K3: the workload for `name`, its sidecars as extra containers, its Services
    and every container's environment Secret; plus the claims and files it mounts."""
    services, mounts = stack.services, Mounts(stack.repo)
    members = [name, *sorted(n for n, owner in SIDECARS.items() if owner == name and n in services)]
    containers, secrets, grace = [], [], 0
    for member in members:
        service = services[member]
        secret = environment_secret(member, service)
        secrets += [secret] if secret else []
        image = image_for(member, service, stack.builders, stack.options)
        containers.append(container(member, service, image, secret, mounts.for_service(member, service)))
        grace = max(grace, seconds(service.get("stop_grace_period"), _DEFAULT_GRACE_S))
    service = services[name]
    labels = {"app.kubernetes.io/name": name, **_pod_labels(members, services)}
    pod = {"terminationGracePeriodSeconds": grace, "containers": containers}
    if mounts.volumes:
        pod["volumes"] = sorted(mounts.volumes.values(), key=lambda v: v["name"])
    aliases = _host_aliases(name, service.get("extra_hosts"), stack.options.get("host_gateway"))
    if aliases:
        pod["hostAliases"] = aliases
    template = {"metadata": {"labels": labels}, "spec": pod}
    return [_workload(name, template), *_services(name, service), *secrets], mounts.objects


def _workload(name: str, template: dict) -> dict:
    selector = {"matchLabels": {"app.kubernetes.io/name": name}}
    spec = {"replicas": 1, "selector": selector, "revisionHistoryLimit": 3, "template": template}
    if name in STATEFUL:
        spec.update(serviceName=dns_name(name), updateStrategy={"type": "RollingUpdate"})
        return {"apiVersion": "apps/v1", "kind": "StatefulSet", "metadata": {"name": dns_name(name)}, "spec": spec}
    spec.update(strategy={"type": "RollingUpdate", "rollingUpdate": {"maxSurge": 1, "maxUnavailable": 0}},
                minReadySeconds=10, progressDeadlineSeconds=300)
    return {"apiVersion": "apps/v1", "kind": "Deployment", "metadata": {"name": dns_name(name)}, "spec": spec}


def _services(name: str, service: dict) -> list:
    """K4: a ClusterIP Service from `expose:`; K9: published ports as a LoadBalancer."""
    out, selector = [], {"app.kubernetes.io/name": name}
    exposed = [_port(p) for p in service.get("expose") or []]
    if exposed:
        ports = [{"name": f"p{p}", "port": p, "targetPort": p} for p in exposed]
        out.append(_service(dns_name(name), "ClusterIP", ports, selector))
    published = [{"name": f"p{p['published']}", "port": int(p["published"]), "targetPort": int(p["target"])}
                 for p in service.get("ports") or []]
    if published:
        out.append(_service(f"{dns_name(name)}-public", "LoadBalancer", published, selector))
    return out


def _service(name: str, kind: str, ports: list, selector: dict) -> dict:
    return {"apiVersion": "v1", "kind": "Service", "metadata": {"name": name},
            "spec": {"type": kind, "selector": selector, "ports": ports}}


def _pod_labels(members: list, services: dict) -> dict:
    labels = {}
    for member in members:
        for key, value in (services[member].get("labels") or {}).items():
            if key == _LOGGING_LABEL:
                labels[_POD_LOGGING_LABEL] = str(value)
            elif not key.startswith("traefik."):  # TODO(OPS-1-o-b): routers become IngressRoutes
                raise RenderError(f"{member}: label {key} has no Kubernetes meaning yet")
    return labels


def _host_aliases(name: str, extra_hosts, host_gateway: str | None) -> list:
    """K3: `extra_hosts` as hostAliases. Docker's `host-gateway` is the machine the
    container runs on; for a pod that is its node, whose address the deploy passes."""
    entries = extra_hosts.items() if isinstance(extra_hosts, dict) else \
        (re.split(r"[=:]", e, maxsplit=1) for e in extra_hosts or [])
    aliases = {}
    for host, address in entries:
        if address == "host-gateway":
            if not host_gateway:
                raise RenderError(f"{name}: extra_hosts {host}=host-gateway needs --host-gateway <node ip>")
            address = host_gateway
        aliases.setdefault(address, []).append(host)
    return [{"ip": ip, "hostnames": hosts} for ip, hosts in sorted(aliases.items())]


def _check_keys(name: str, service: dict) -> None:
    unknown = set(service) - _MAPPED_KEYS - DROPPED_KEYS
    if unknown:
        raise RenderError(f"{name}: compose key(s) {', '.join(sorted(unknown))} not mapped (K2)")
    if service.get("restart") not in ALWAYS_RESTART:
        raise RenderError(f"{name}: restart {service['restart']!r} — a pod always restarts (K3)")


def _check_calls(services: dict) -> None:
    """K4: every service named in an environment value answers on that port."""
    exposed = {n: {_port(p) for p in s.get("expose") or []} for n, s in services.items()}
    for name, service in services.items():
        for value in (service.get("environment") or {}).values():
            for host, port in _HOST_REF.findall(str(value or "")):
                if host not in services or host == name:
                    continue
                if not exposed[host] or (port and int(port) not in exposed[host]):
                    raise RenderError(f"{name}: calls {host}:{port or '?'}, which {host} does not expose (K4)")


def _port(value) -> int:
    return int(str(value).split("/", 1)[0])
