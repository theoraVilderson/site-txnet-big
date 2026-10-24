"""Small builders shared by the renderer's parts: names, durations, hashed objects."""
import base64
import hashlib
import json
import math
import re


class RenderError(Exception):
    """A compose fact the renderer cannot map; the message names the service (K2)."""


def dns_name(text: str) -> str:
    """A Kubernetes object name (DNS-1123) from a compose name or a path."""
    name = re.sub(r"[^a-z0-9-]+", "-", text.lower()).strip("-")
    return re.sub(r"-{2,}", "-", name)[:63].rstrip("-")


_DURATION = re.compile(r"(?:(\d+)h)?(?:(\d+)m(?!s))?(?:(\d+(?:\.\d+)?)s)?(?:(\d+)ms)?$")


def seconds(duration, default: int) -> int:
    """Compose's Go-style duration ("1m0s", "10s", "500ms") in whole seconds, rounded up."""
    if duration in (None, ""):
        return default
    match = _DURATION.match(str(duration))
    if not match or not any(match.groups()):
        raise RenderError(f"unreadable duration {duration!r}")
    h, m, s, ms = (float(g) if g else 0.0 for g in match.groups())
    return max(1, math.ceil(h * 3600 + m * 60 + s + ms / 1000))


def undo_compose_escaping(value):
    """`docker compose config` prints every literal `$` as `$$`, so its output reads
    back as compose input; a pod needs the value itself (K2, K5)."""
    if isinstance(value, dict):
        return {k: undo_compose_escaping(v) for k, v in value.items()}
    if isinstance(value, list):
        return [undo_compose_escaping(v) for v in value]
    return value.replace("$$", "$") if isinstance(value, str) else value


def escape_expansion(text: str) -> str:
    """Kubernetes expands `$(X)` and folds `$$` in command and args (K5); keep the literal."""
    return re.sub(r"\$(?=[$(])", "$$", text)


def hashed(kind: str, base_name: str, data: dict) -> dict:
    """A Secret or ConfigMap whose name carries a hash of its data, as Kustomize's
    generators do, so a changed value rolls every pod that mounts it (K5)."""
    digest = hashlib.sha256(json.dumps(data, sort_keys=True, default=bytes.hex).encode()).hexdigest()[:10]
    obj = {"apiVersion": "v1", "kind": kind, "metadata": {"name": f"{base_name}-{digest}"}}
    if kind == "Secret":
        obj["type"] = "Opaque"
        obj["data"] = {k: base64.b64encode(v if isinstance(v, bytes) else v.encode()).decode()
                       for k, v in data.items()}
    else:
        obj["data"] = data
    return obj
