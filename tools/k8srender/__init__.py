"""Render a production compose model into a Kustomize base (ADR-0147, hosting K2-K7, K11).

`render(model, repo, options)` takes what `docker compose config --format json`
prints and returns {file name: objects}; `tools/k8s_render.py` writes them.
"""
import re
from dataclasses import dataclass
from pathlib import Path

from .container import container, environment_secret, image_for
from .monitoring import as_log_shipper, peer_services, scrape_calls
from .objects import RenderError, dns_name, port_number, seconds, undo_compose_escaping
from .tables import (ALWAYS_RESTART, DAEMONSETS, DROPPED_KEYS, LOG_SHIPPER, NAMESPACE, PROVIDED_BY_KUBERNETES,
                     SERVICE_ACCOUNTS, SIDECARS, STATEFUL, TRAEFIK)
from .traefik import Labels, as_edge, backend_index, edge_objects, labels_of
from .volumes import Mounts

__all__ = ["RenderError", "exposed_ports", "render"]

PART_OF = {"app.kubernetes.io/part-of": "txnet"}
# K3: compose's stop grace when a service names none.
_DEFAULT_GRACE_S = 10
# K8: a Job is applied on its own, before the base (K10), so it is written beside it.
JOBS_DIR = "jobs"
# K8: a run-once Job's limits. A failed migration is read, not retried (C-39);
# its pod is kept a day for its log.
_JOB_DEADLINE_S, _JOB_KEPT_S = 900, 86400
_MAPPED_KEYS = {"command", "configs", "entrypoint", "environment", "expose", "extra_hosts", "healthcheck",
                "image", "labels", "mem_limit", "mem_reservation", "cpus", "ports", "restart", "secrets", "shm_size",
                "stop_grace_period", "tmpfs", "volumes", "working_dir"}
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
    traefik: dict  # compose service -> its Traefik labels (K9)
    backends: dict  # Traefik service name -> (compose service, port)
    declared: dict  # the model's top-level `configs:` and `secrets:` (K11)


def render(model: dict, repo: Path, options: dict) -> dict:
    """options: registry, tag, host_gateway; namespace (default K1's), `publish`
    (False: no LoadBalancer, K11), `peer` — {namespace, exposed: {service:
    {ports}}} of the stack this one calls by name across namespaces — and
    `sealed_root`, the directory the secret files were opened into (K5)."""
    namespace, peer = options.get("namespace", NAMESPACE), options.get("peer")
    services = {name: service for name, service in undo_compose_escaping(model)["services"].items()
                if name not in PROVIDED_BY_KUBERNETES}
    declared = {kind: model.get(kind) or {} for kind in ("configs", "secrets")}
    for name, service in services.items():
        _check_keys(name, service)
    traefik = {name: labels_of(name, service) for name, service in services.items()}
    peers = _check_calls(services, traefik, peer) | scrape_calls(services, declared, peer)
    builders = {s["image"]: n for n, s in services.items() if s.get("build") and s.get("image")}
    stack = _Stack(services, builders, options, repo, traefik, backend_index(traefik), declared)
    files, jobs, shared = {}, {}, {}
    for name in sorted(services):
        if name in SIDECARS:
            continue
        objects, mounted = _pod(stack, name)
        (jobs if _runs_once(services[name]) else files)[f"{name}.yaml"] = objects
        shared.update(mounted)
    files["storage.yaml"] = [o for k, o in sorted(shared.items()) if k.startswith("pvc/")]
    files["files.yaml"] = [o for k, o in sorted(shared.items()) if k.startswith("file/")]
    files["namespace.yaml"] = [{"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": namespace}}]
    files["peers.yaml"] = peer_services(peers, peer["namespace"]) if peers else []
    files = {k: v for k, v in files.items() if v}
    files["kustomization.yaml"] = _kustomization(files, namespace)
    if jobs:
        files.update({f"{JOBS_DIR}/{k}": v for k, v in jobs.items()})
        files[f"{JOBS_DIR}/kustomization.yaml"] = _kustomization(jobs, namespace)
    return files


def _kustomization(files: dict, namespace: str) -> dict:
    return {"apiVersion": "kustomize.config.k8s.io/v1beta1", "kind": "Kustomization",
            "namespace": namespace, "resources": sorted(files),
            "labels": [{"pairs": PART_OF, "includeSelectors": False}]}


def _runs_once(service: dict) -> bool:
    """K8: a compose service that exits when done (`restart: "no"`) is a Job, not a workload."""
    return service.get("restart") == "no"


def _pod(stack: _Stack, name: str) -> tuple[list, dict]:
    """K3: the workload for `name`, its sidecars as extra containers, its Services
    and every container's environment Secret; plus the claims and files it mounts."""
    services, mounts = stack.services, Mounts(stack.repo, stack.declared, stack.options.get("sealed_root"))
    members = [name, *sorted(n for n, owner in SIDECARS.items() if owner == name and n in services)]
    containers, secrets, grace = [], [], 0
    for member in members:
        service = services[member]
        secret = environment_secret(member, service)
        secrets += [secret] if secret else []
        image = image_for(member, service, stack.builders, stack.options)
        containers.append(container(member, service, image, secret, mounts.for_service(member, service),
                                    sidecar=member != name))
        grace = max(grace, seconds(service.get("stop_grace_period"), _DEFAULT_GRACE_S))
    service = services[name]
    labels = {"app.kubernetes.io/name": name, **_pod_labels(members, services)}
    pod = {"terminationGracePeriodSeconds": grace, "containers": containers}
    if mounts.volumes:
        pod["volumes"] = sorted(mounts.volumes.values(), key=lambda v: v["name"])
    aliases = _host_aliases(name, service.get("extra_hosts"), stack.options.get("host_gateway"))
    if aliases:
        pod["hostAliases"] = aliases
    if name == TRAEFIK:
        as_edge(pod)
    if name == LOG_SHIPPER:
        as_log_shipper(pod)
    if name in SERVICE_ACCOUNTS:
        pod["serviceAccountName"] = SERVICE_ACCOUNTS[name]
    template = {"metadata": {"labels": labels}, "spec": pod}
    routing = edge_objects(name, stack.traefik[name], stack.backends)
    workload = _job(name, template) if _runs_once(service) else _workload(name, template)
    services = _services(name, service, stack.traefik[name], stack.options.get("publish", True))
    return [workload, *services, *routing, *secrets], mounts.objects


def _workload(name: str, template: dict) -> dict:
    selector = {"matchLabels": {"app.kubernetes.io/name": name}}
    if name in DAEMONSETS:
        # K11: one pod per node, replaced one node at a time.
        spec = {"selector": selector, "revisionHistoryLimit": 3, "minReadySeconds": 10, "template": template,
                "updateStrategy": {"type": "RollingUpdate", "rollingUpdate": {"maxUnavailable": 1}}}
        return {"apiVersion": "apps/v1", "kind": "DaemonSet", "metadata": {"name": dns_name(name)}, "spec": spec}
    spec = {"replicas": 1, "selector": selector, "revisionHistoryLimit": 3, "template": template}
    if name in STATEFUL:
        spec.update(serviceName=dns_name(name), updateStrategy={"type": "RollingUpdate"})
        return {"apiVersion": "apps/v1", "kind": "StatefulSet", "metadata": {"name": dns_name(name)}, "spec": spec}
    spec.update(strategy={"type": "RollingUpdate", "rollingUpdate": {"maxSurge": 1, "maxUnavailable": 0}},
                minReadySeconds=10, progressDeadlineSeconds=300)
    return {"apiVersion": "apps/v1", "kind": "Deployment", "metadata": {"name": dns_name(name)}, "spec": spec}


def _job(name: str, template: dict) -> dict:
    template["spec"]["restartPolicy"] = "Never"
    spec = {"backoffLimit": 0, "activeDeadlineSeconds": _JOB_DEADLINE_S, "ttlSecondsAfterFinished": _JOB_KEPT_S,
            "template": template}
    return {"apiVersion": "batch/v1", "kind": "Job",
            "metadata": {"name": dns_name(name), "labels": {"app.kubernetes.io/name": name}}, "spec": spec}


def _services(name: str, service: dict, traefik: Labels, publish: bool) -> list:
    """K4: a ClusterIP Service from `expose:` and the ports Traefik calls (K9);
    published ports as a LoadBalancer that keeps the client's address, unless
    the stack publishes nothing (K11)."""
    out, selector = [], {"app.kubernetes.io/name": name}
    exposed = sorted({port_number(p) for p in service.get("expose") or []} | set(traefik.backends.values()))
    if exposed:
        ports = [{"name": f"p{p}", "port": p, "targetPort": p} for p in exposed]
        out.append(_service(dns_name(name), "ClusterIP", ports, selector))
    published = [{"name": f"p{p['published']}", "port": int(p["published"]), "targetPort": int(p["target"])}
                 for p in service.get("ports") or []] if publish else []
    if published:
        public = _service(f"{dns_name(name)}-public", "LoadBalancer", published, selector)
        # Local: a request reaches the pod on its own node with its source
        # address intact, which Traefik's client-address rules read (O5, O7).
        public["spec"]["externalTrafficPolicy"] = "Local"
        out.append(public)
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
            elif not key.startswith("traefik."):  # K9: Traefik's labels become IngressRoutes
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
    if service.get("restart") not in ALWAYS_RESTART and not _runs_once(service):
        raise RenderError(f"{name}: restart {service['restart']!r} — a pod always restarts (K3)")


def _check_calls(services: dict, traefik: dict, peer: dict | None) -> set:
    """K4: every service named in an environment value answers on that port, and so
    does every ForwardAuth address, which Traefik calls (K9). A name the peer
    stack serves is checked against its `expose:`; returns the peer names called (K11)."""
    exposed = exposed_ports(services)
    calls = [(name, value) for name, service in services.items()
             for value in (service.get("environment") or {}).values()]
    calls += [(TRAEFIK, address) for labels in traefik.values() for address in labels.forward_auth_addresses()]
    called = set()
    for caller, value in calls:
        for host, port in _HOST_REF.findall(str(value or "")):
            if host == caller:
                continue
            if host in services:
                ports = exposed[host]
            elif peer and host in peer["exposed"]:
                ports = peer["exposed"][host]
                called.add(host)
            else:
                continue
            if not ports or (port and int(port) not in ports):
                raise RenderError(f"{caller}: calls {host}:{port or '?'}, which {host} does not expose (K4)")
    return called


def exposed_ports(services: dict) -> dict:
    """K4: each compose service's `expose:` ports — what it answers on, here or
    for a stack that calls it by name (K11)."""
    return {name: {port_number(p) for p in service.get("expose") or []} for name, service in services.items()}

