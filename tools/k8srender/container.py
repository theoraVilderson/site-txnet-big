"""One compose service -> one container spec and its environment Secret (K5, K6, K8)."""
import math

from .objects import RenderError, dns_name, escape_expansion, hashed, seconds

# K6: compose's own defaults when a healthcheck leaves a field out.
_HC_INTERVAL_S, _HC_TIMEOUT_S, _HC_RETRIES = 30, 30, 3


def image_for(name: str, service: dict, builders: dict[str, str], options: dict) -> str:
    """K8: a built image is pushed as `<registry>/txnet/<builder>:<tag>`; a pulled one
    keeps its name. `builders` maps a compose image name to the service building it,
    so pg-backup runs main-db's image without building it twice."""
    builder = name if service.get("build") else builders.get(service.get("image", ""))
    if builder:
        return f"{options['registry']}/txnet/{builder}:{options['tag']}"
    if not service.get("image"):
        raise RenderError(f"{name}: neither build nor image")
    return service["image"]


def built_images(services: dict, project: str, options: dict) -> list[tuple[str, str, str]]:
    """K8: (service, the name compose tags its build with, the name the node pulls)
    for every service compose builds."""
    return [(name, service.get("image") or f"{project}-{name}", image_for(name, service, {}, options))
            for name, service in sorted(services.items()) if service.get("build")]


def environment_secret(name: str, service: dict) -> dict | None:
    """K5: the service's whole rendered environment, and nothing else. Values are not
    expanded by Kubernetes through envFrom, so they need no escaping."""
    env = {k: str(v) for k, v in (service.get("environment") or {}).items() if v is not None}
    return hashed("Secret", f"{dns_name(name)}-env", env) if env else None


def container(name: str, service: dict, image: str, env_secret: dict | None, mounts: list, *,
              sidecar: bool = False) -> dict:
    spec = {"name": dns_name(name), "image": image, "imagePullPolicy": "IfNotPresent"}
    if service.get("entrypoint"):
        spec["command"] = [escape_expansion(a) for a in _argv(service["entrypoint"])]
    if service.get("command"):
        spec["args"] = [escape_expansion(a) for a in _argv(service["command"])]
    if service.get("working_dir"):
        spec["workingDir"] = service["working_dir"]
    if env_secret:
        spec["envFrom"] = [{"secretRef": {"name": env_secret["metadata"]["name"]}}]
    limits = _limits(service)
    if limits:
        spec["resources"] = {"limits": limits}
    spec.update(probes(name, service.get("healthcheck"), sidecar=sidecar))
    if mounts:
        spec["volumeMounts"] = mounts
    return spec


def probes(name: str, healthcheck: dict | None, *, sidecar: bool = False) -> dict:
    """K6: the compose healthcheck as readiness and liveness, with a startup probe
    holding both off for the start period. A sidecar gets no readiness: a pod is
    ready only when every container is, and pg-backup failing must restart the
    backup, never take main-db out of its Service."""
    if not healthcheck or healthcheck.get("disable"):
        return {}
    test = healthcheck.get("test") or []
    if test[:1] == ["CMD"]:
        command = test[1:]
    elif test[:1] == ["CMD-SHELL"]:
        command = ["sh", "-c", test[1]]
    elif test[:1] == ["NONE"]:
        return {}
    else:
        raise RenderError(f"{name}: healthcheck test {test!r}")
    period = seconds(healthcheck.get("interval"), _HC_INTERVAL_S)
    base = {"exec": {"command": command}, "periodSeconds": period,
            "timeoutSeconds": seconds(healthcheck.get("timeout"), _HC_TIMEOUT_S),
            "failureThreshold": int(healthcheck.get("retries") or _HC_RETRIES)}
    out = {"livenessProbe": dict(base)} if sidecar else {"readinessProbe": dict(base), "livenessProbe": dict(base)}
    start = seconds(healthcheck.get("start_period"), 0) if healthcheck.get("start_period") else 0
    if start:
        out["startupProbe"] = {**base, "failureThreshold": math.ceil(start / period)}
    return out


def _limits(service: dict) -> dict:
    limits = {}
    if service.get("mem_limit"):
        limits["memory"] = str(service["mem_limit"])
    if service.get("cpus"):
        limits["cpu"] = str(service["cpus"])
    return limits


def _argv(value) -> list[str]:
    """`docker compose config` prints command and entrypoint as lists; a string
    survives only from a hand-built model, and a shell would split it."""
    return [str(a) for a in value] if isinstance(value, list) else ["sh", "-c", str(value)]
