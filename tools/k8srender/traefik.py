"""K9: Traefik's Docker labels -> IngressRoute and Middleware objects.

Traefik read its routers and middlewares from container labels; on Kubernetes
it reads the same definitions from CRD objects. Each label set becomes one
object of the same name, so an `@file` reference and the entrypoint
middlewares in the baked dynamic/ keep working unchanged.
"""
import re
from dataclasses import dataclass, field

from .objects import RenderError, dns_name, hashed
from .tables import STACKS, TRAEFIK_DROPPED_ARG, TRAEFIK_PROVIDER_ARGS, TRAEFIK_SERVICE_ACCOUNT

_API = "traefik.io/v1alpha1"
_DOCKER_SUFFIX = "@docker"
_INTERNAL_SUFFIX = "@internal"
_BACKEND_PORT_KEY = "loadbalancer.server.port"
# No `tls.certresolver`: a door's certificate is never fetched online (hosting
# O13, ADR-0165 point 4), so a route naming a resolver fails the render (K2).
_ROUTER_KEY = re.compile(r"(rule|entrypoints|middlewares|priority|service|tls"
                         r"|tls\.domains\[\d+\]\.(main|sans))$")
_DOMAIN_KEY = re.compile(r"tls\.domains\[(\d+)\]\.(main|sans)$")

# A middleware label `<type>.<field>` -> the CRD's spelling and the value's type.
# Traefik reads label keys case-insensitively, so the keys here are lower case;
# a `dict` field keeps the case of its sub-key, which is a header name.
_MIDDLEWARES = {
    "forwardauth": ("forwardAuth", {"address": ("address", str),
                                    "authresponseheaders": ("authResponseHeaders", list)}),
    "headers": ("headers", {"customrequestheaders": ("customRequestHeaders", dict),
                            "customresponseheaders": ("customResponseHeaders", dict),
                            "browserxssfilter": ("browserXssFilter", bool),
                            "contenttypenosniff": ("contentTypeNosniff", bool),
                            "customframeoptionsvalue": ("customFrameOptionsValue", str),
                            "forcestsheader": ("forceSTSHeader", bool),
                            "stsincludesubdomains": ("stsIncludeSubdomains", bool),
                            "stsseconds": ("stsSeconds", int)}),
    "ratelimit": ("rateLimit", {"average": ("average", int), "burst": ("burst", int),
                                "period": ("period", str)}),
    "stripprefix": ("stripPrefix", {"prefixes": ("prefixes", list)}),
    "compress": ("compress", {}),
}


@dataclass
class Labels:
    """One container's Traefik labels, grouped by the object each set defines."""
    routers: dict = field(default_factory=dict)  # router -> {lower-case key: value}
    middlewares: dict = field(default_factory=dict)  # middleware -> [(key parts, value)]
    backends: dict = field(default_factory=dict)  # Traefik service name -> port

    def forward_auth_addresses(self) -> list[str]:
        """The addresses Traefik calls for ForwardAuth, which K4 checks like any call."""
        return [v for entries in self.middlewares.values() for parts, v in entries
                if [p.lower() for p in parts] == ["forwardauth", "address"]]


def labels_of(name: str, service: dict) -> Labels:
    """The labels Traefik would read: none unless the container opts in (exposedbydefault=false)."""
    labels, out = service.get("labels") or {}, Labels()
    if str(labels.get("traefik.enable", "")).lower() != "true":
        return out
    for key, value in labels.items():
        if not key.startswith("traefik.") or key == "traefik.enable":
            continue
        parts = key.split(".")
        group, rest = ".".join(parts[1:3]).lower(), parts[4:]
        if group == "http.routers" and rest:
            out.routers.setdefault(parts[3], {})[".".join(rest).lower()] = str(value)
        elif group == "http.middlewares" and rest:
            out.middlewares.setdefault(parts[3], []).append((rest, str(value)))
        elif group == "http.services" and ".".join(rest).lower() == _BACKEND_PORT_KEY:
            out.backends[parts[3]] = int(value)
        else:
            raise RenderError(f"{name}: label {key} has no Kubernetes mapping (K9)")
    return out


def backend_index(labels: dict[str, Labels]) -> dict[str, tuple[str, int]]:
    """Every Traefik service name -> the compose service answering it and its port."""
    return {backend: (owner, port) for owner, found in labels.items() for backend, port in found.backends.items()}


def edge_objects(owner: str, labels: Labels, backends: dict) -> list:
    """The IngressRoutes and Middlewares one container's labels define, and the
    Secrets a basic-auth middleware reads its users from."""
    out = []
    for router, keys in sorted(labels.routers.items()):
        out.append(_ingress_route(owner, router, keys, labels, backends))
    for middleware, entries in sorted(labels.middlewares.items()):
        out += _middleware(owner, middleware, entries)
    return out


def as_edge(pod: dict) -> None:
    """Traefik's own pod: the CRD provider in place of the Docker socket, read as
    the service account k8s/traefik/ grants it to, in every stack's namespace —
    Grafana's IngressRoute is in txnet-monitoring (K11)."""
    container = pod["containers"][0]
    args = [a for a in container.get("args", []) if not a.startswith(TRAEFIK_DROPPED_ARG)]
    namespaces = ",".join(stack.namespace for stack in STACKS.values())
    container["args"] = [*TRAEFIK_PROVIDER_ARGS, f"--providers.kubernetescrd.namespaces={namespaces}", *args]
    pod["serviceAccountName"] = TRAEFIK_SERVICE_ACCOUNT


def _ingress_route(owner: str, router: str, keys: dict, labels: Labels, backends: dict) -> dict:
    unknown = sorted(k for k in keys if not _ROUTER_KEY.match(k))
    if unknown or "rule" not in keys:
        raise RenderError(f"{owner}: router {router} has {', '.join(unknown) or 'no rule'} (K9)")
    rule = {"match": keys["rule"], "kind": "Rule"}
    if "priority" in keys:
        rule["priority"] = int(keys["priority"])
    middlewares = _split(keys.get("middlewares"))
    if middlewares:
        rule["middlewares"] = [{"name": _reference(m)} for m in middlewares]
    rule["services"] = [_backend(owner, router, keys.get("service"), labels, backends)]
    spec = {"entryPoints": _split(keys["entrypoints"])} if "entrypoints" in keys else {}
    spec["routes"] = [rule]
    tls = _tls(keys)
    if tls is not None:
        spec["tls"] = tls
    return {"apiVersion": _API, "kind": "IngressRoute", "metadata": {"name": dns_name(router)}, "spec": spec}


def _backend(owner: str, router: str, name: str | None, labels: Labels, backends: dict) -> dict:
    """A router naming no service uses its container's only one, as Traefik's Docker provider did."""
    if name is None and len(labels.backends) == 1:
        name = next(iter(labels.backends))
    if name and name.endswith(_INTERNAL_SUFFIX):
        return {"name": name, "kind": "TraefikService"}
    target = backends.get((name or "").removesuffix(_DOCKER_SUFFIX))
    if not target:
        raise RenderError(f"{owner}: router {router} names service {name}, which no container defines (K4)")
    service, port = target
    return {"name": dns_name(service), "port": port}


def _tls(keys: dict) -> dict | None:
    if not any(k == "tls" or k.startswith("tls.") for k in keys) or keys.get("tls", "").lower() == "false":
        return None
    tls, domains = {}, {}
    for key, value in keys.items():
        match = _DOMAIN_KEY.match(key)
        if match:
            index, part = int(match[1]), match[2]
            domains.setdefault(index, {})[part] = value if part == "main" else _split(value)
    if domains:
        tls["domains"] = [domains[i] for i in sorted(domains)]
    return tls


def _middleware(owner: str, name: str, entries: list) -> list:
    spec, secrets = {}, []
    for parts, value in entries:
        kind = parts[0].lower()
        if [p.lower() for p in parts] == ["basicauth", "users"]:
            # The CRD takes basic-auth users only from a Secret, never inline (K5).
            secret = hashed("Secret", f"{dns_name(name)}-users", {"users": "\n".join(_split(value))})
            spec["basicAuth"] = {"secret": secret["metadata"]["name"]}
            secrets.append(secret)
            continue
        if kind not in _MIDDLEWARES:
            raise RenderError(f"{owner}: middleware {name} of type {parts[0]} has no mapping (K9)")
        crd, fields = _MIDDLEWARES[kind]
        body = spec.setdefault(crd, {})
        if len(parts) == 1 and not fields and value.lower() == "true":
            continue
        field_name = parts[1].lower() if len(parts) > 1 else ""
        crd_field, kind_of = fields.get(field_name, (None, None))
        if not crd_field or len(parts) != (3 if kind_of is dict else 2):
            raise RenderError(f"{owner}: middleware {name} label {'.'.join(parts)} has no mapping (K9)")
        if kind_of is dict:
            body.setdefault(crd_field, {})[parts[2]] = value
        else:
            body[crd_field] = _typed(owner, kind_of, value)
    middleware = {"apiVersion": _API, "kind": "Middleware", "metadata": {"name": dns_name(name)}, "spec": spec}
    return [middleware, *secrets]


def _typed(owner: str, kind_of: type, value: str):
    if kind_of is int:
        return int(value)
    if kind_of is bool:
        if value.lower() not in ("true", "false"):
            raise RenderError(f"{owner}: {value!r} is not a boolean (K9)")
        return value.lower() == "true"
    return _split(value) if kind_of is list else value


def _reference(middleware: str) -> str:
    """A Docker-provider name is ours on Kubernetes; any other provider's (`@file`) stays as named."""
    if middleware.endswith(_DOCKER_SUFFIX):
        return dns_name(middleware.removesuffix(_DOCKER_SUFFIX))
    return middleware if "@" in middleware else dns_name(middleware)


def _split(value: str | None) -> list[str]:
    return [v.strip() for v in (value or "").split(",") if v.strip()]
