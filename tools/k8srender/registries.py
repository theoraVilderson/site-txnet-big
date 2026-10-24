"""K14: the node's /etc/rancher/k3s/registries.yaml — where it pulls, as whom.
Written by `scripts/prod.k8s.sh registries` from the sealed env files."""
import yaml

from .objects import RenderError

# The pull-only login lives in .env.prod, sealed with every other secret (K5).
PULL_LOGIN = ("LOCAL_DOCKER_REGISTRY_PULL_USER", "LOCAL_DOCKER_REGISTRY_PULL_PASSWORD")
# Docker Hub as containerd names it: k3s's own images (pause, coredns, servicelb)
# are under it, and the node reaches it only through DOCKER_REGISTRY's mirror.
_DOCKER_HUB = "docker.io"


def registries_yaml(variables: dict) -> str:
    """registries.yaml for the interpolated env `variables`; a missing value fails,
    since a node with no login pulls nothing of ours and says so only per pod."""
    needed = ("DOCKER_REGISTRY", "LOCAL_DOCKER_REGISTRY", *PULL_LOGIN)
    missing = [name for name in needed if not variables.get(name)]
    if missing:
        raise RenderError(f"{', '.join(missing)} not set in the env files (K14)")
    user, password = (variables[name] for name in PULL_LOGIN)
    config = {
        "mirrors": {_DOCKER_HUB: {"endpoint": [f"https://{variables['DOCKER_REGISTRY']}"]}},
        "configs": {variables["LOCAL_DOCKER_REGISTRY"]: {"auth": {"username": user, "password": password}}},
    }
    return yaml.safe_dump(config, sort_keys=False)
