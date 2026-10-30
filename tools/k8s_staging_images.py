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
left (`keep`). Then, the node stopped, containerd's bolt files are compacted
(`seal`): a deleted container's record stays in a bolt file's freed pages, and
with it the env production's Secrets gave it (found live 2026-10-30). Anything
short of either, and the volume goes with the rest.
"""
import json
import os
import shutil
import subprocess
import time
from pathlib import Path

IMAGES_VOLUME = "txnet-staging-images"
CONTAINERD_DIR = "/var/lib/rancher/k3s/agent/containerd"
# The cluster's own: k3s's system pods run here, and nothing of production's does.
SYSTEM_NAMESPACES = frozenset({"kube-system", "kube-public", "kube-node-lease", "default"})
# How long `down` waits for production's pods to leave the node before giving up the images.
DRAIN_TRIES, DRAIN_POLL_S = 20, 3
POD_NAMESPACE_LABEL = "io.kubernetes.pod.namespace"
# containerd's bolt databases, relative to CONTAINERD_DIR: images, containers and
# leases in the first, snapshot keys in the second.
BOLT_FILES = ("io.containerd.metadata.v1.bolt/meta.db", "io.containerd.snapshotter.v1.overlayfs/metadata.db")
CONTAINERD_LOG = "containerd.log"
# The bbolt CLI that compacts them; the library containerd itself is built on.
BBOLT_VERSION = "v1.4.3"
BBOLT_PACKAGE = "go.etcd.io/bbolt/cmd/bbolt"
BBOLT_DIR = Path("/var/cache/txnet-staging") / f"bbolt-{BBOLT_VERSION}"
# The dev host's Go is not on PATH (it is installed under /usr/local/go).
GO_FALLBACK = "/usr/local/go/bin/go"


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


def _mountpoint(docker) -> str | None:
    inspected = docker(["docker", "volume", "inspect", "-f", "{{.Mountpoint}}", IMAGES_VOLUME], check=False)
    return inspected.stdout.strip() if inspected.returncode == 0 else None


def bbolt() -> Path:
    """The pinned bbolt CLI, built once into the cache directory."""
    tool = BBOLT_DIR / "bbolt"
    if not tool.exists():
        go = shutil.which("go") or GO_FALLBACK
        subprocess.run([go, "install", f"{BBOLT_PACKAGE}@{BBOLT_VERSION}"], check=True, capture_output=True,
                       env={**os.environ, "GOBIN": str(BBOLT_DIR)})
    return tool


def compact_bolt(src: str, dst: str) -> None:
    """A fresh file with the live records only: freed pages are not copied."""
    subprocess.run([str(bbolt()), "compact", "-o", dst, src], check=True, capture_output=True)


def seal(docker, compact=compact_bolt) -> bool:
    """After the node is gone: each bolt file replaced by its compaction, containerd's
    log removed. True when the store stays; on any failure it is removed."""
    try:
        root = _mountpoint(docker)
        if root is None:
            return False
        for rel in BOLT_FILES:
            path = Path(root) / rel
            if path.exists():
                fresh = path.with_name(path.name + ".compact")
                fresh.unlink(missing_ok=True)
                compact(str(path), str(fresh))
                os.replace(fresh, path)
        (Path(root) / CONTAINERD_LOG).unlink(missing_ok=True)
        return True
    except Exception:  # noqa: BLE001 — any doubt means the images go, never production's env stays
        docker(["docker", "volume", "rm", IMAGES_VOLUME], check=False)
        return False


def held_bytes(docker) -> int:
    """What the kept store takes on the disk now: part of staging's peak already."""
    root = _mountpoint(docker)
    if root is None:
        return 0
    return int(docker(["du", "-sb", root]).stdout.split()[0])
