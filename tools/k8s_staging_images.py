#!/usr/bin/env python3
"""Staging's image store, kept between releases (hosting R14, OPS-1-ah-e; amends
ADR-0166 point 1).

k3s's containerd sits on a volume of its own, IMAGES_VOLUME, inside the k3s
volume `down` still removes: the server's database, the PVs that hold
production's rows and the kubelet's files are not on it. A twin then imports
only the images that changed instead of all ~36 (~5 min).

`down` keeps it only when it can prove, on the running node, that the store
holds images and nothing of production's: every namespace but the cluster's own
deleted, their pods removed with their containers and writable layers, none
left. Anything short of that proof, and the volume goes with the rest.
"""
import json
import time

IMAGES_VOLUME = "txnet-staging-images"
CONTAINERD_DIR = "/var/lib/rancher/k3s/agent/containerd"
# The cluster's own: k3s's system pods run here, and nothing of production's does.
SYSTEM_NAMESPACES = frozenset({"kube-system", "kube-public", "kube-node-lease", "default"})
# How long `down` waits for production's pods to leave the node before giving up the images.
DRAIN_TRIES, DRAIN_POLL_S = 20, 3
POD_NAMESPACE_LABEL = "io.kubernetes.pod.namespace"


def mount_args() -> list[str]:
    """The `docker run` volume for the store, nested inside the k3s volume's mount."""
    return ["-v", f"{IMAGES_VOLUME}:{CONTAINERD_DIR}"]


def app_namespaces(names: list[str]) -> list[str]:
    """The namespaces a deploy made: production's."""
    return [n for n in names if n not in SYSTEM_NAMESPACES]


def leftover_pods(listing: str) -> list[str]:
    """crictl's pod sandboxes outside the cluster's own namespaces."""
    return [p["id"] for p in json.loads(listing or "{}").get("items") or []
            if p["metadata"]["namespace"] not in SYSTEM_NAMESPACES]


def leftover_containers(listing: str) -> list[str]:
    """crictl's containers, running or exited, outside the cluster's own namespaces."""
    return [c["id"] for c in json.loads(listing or "{}").get("containers") or []
            if c.get("labels", {}).get(POD_NAMESPACE_LABEL) not in SYSTEM_NAMESPACES]


def _drain(docker, node: str, sleep) -> bool:
    """Production's pods off the node, containers and writable layers with them."""
    on_node = ["docker", "exec", node]
    # First, while the release runs: the images it does not use go, so the store holds one release.
    docker([*on_node, "crictl", "rmi", "--prune"], check=False)
    names = docker([*on_node, "kubectl", "get", "namespaces", "-o", "jsonpath={.items[*].metadata.name}"]).stdout
    apps = app_namespaces(names.split())
    # A terminating namespace takes no new pod, so nothing re-creates what is removed below.
    if apps:
        docker([*on_node, "kubectl", "delete", "namespace", *apps, "--wait=false", "--ignore-not-found"])
    for _ in range(DRAIN_TRIES):
        sandboxes = leftover_pods(docker([*on_node, "crictl", "pods", "-o", "json"]).stdout)
        if sandboxes:
            docker([*on_node, "crictl", "rmp", "-f", *sandboxes], check=False)
        left = leftover_containers(docker([*on_node, "crictl", "ps", "-a", "-o", "json"]).stdout)
        if not sandboxes and not left:
            return True
        sleep(DRAIN_POLL_S)
    return False


def keep(docker, node: str, sleep=time.sleep) -> bool:
    """True when the store was proven to hold only images and stays; else it is removed."""
    try:
        running = docker(["docker", "inspect", "-f", "{{.State.Running}}", node], check=False)
        proven = running.returncode == 0 and running.stdout.strip() == "true" and _drain(docker, node, sleep)
    except Exception:  # noqa: BLE001 — any doubt means the images go, never production's data stays
        proven = False
    if not proven:
        docker(["docker", "volume", "rm", IMAGES_VOLUME], check=False)
    return proven


def held_bytes(docker) -> int:
    """What the kept store takes on the disk now: part of staging's peak already."""
    inspected = docker(["docker", "volume", "inspect", "-f", "{{.Mountpoint}}", IMAGES_VOLUME], check=False)
    if inspected.returncode != 0:
        return 0
    return int(docker(["du", "-sb", inspected.stdout.strip()]).stdout.split()[0])
