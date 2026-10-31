#!/usr/bin/env python3
"""The release's `disk` step (hosting R21, contract.release-disk.md).

Before a build, the build host drops what earlier releases left: their image
tags, which `docker image prune` never sees because each is still tagged, and
the build cache of the builder compose uses past BUILD_CACHE_KEEP. Then R14's
room check runs.
"""
import subprocess
import sys
from pathlib import Path
from typing import Callable

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import k8s_staging as ks  # noqa: E402

# Enough for an unchanged service's layers to stay cached between releases;
# measured 2026-10-31: 11 GB uncapped, 2.9 GB after one day's builds.
BUILD_CACHE_KEEP = "3gb"
UNTAGGED = "<none>"


def repository(ref: str) -> str:
    """`reg:5000/txnet/api:tag` -> `reg:5000/txnet/api`; a port is not a tag."""
    return ref.rsplit(":", 1)[0]


def stale_images(current: list[str], local: list[str]) -> list[str]:
    """Local tags of the release's repositories that the current release does not name."""
    repos = {repository(ref) for ref in current}
    keep = set(current)
    return [ref for ref in local
            if repository(ref) in repos and ref not in keep and not ref.endswith(":" + UNTAGGED)]


def release_images(run: Callable) -> list[str]:
    """The registry image of every service this release builds (K8), as `build` lists them."""
    listing = run(["python3", str(ROOT / "tools" / "k8s_render.py"), "--images"],
                  check=True, capture_output=True, text=True).stdout
    return [line.split("\t")[2] for line in listing.splitlines() if line.count("\t") == 2]


def local_images(run: Callable) -> list[str]:
    return run(["docker", "image", "ls", "--format", "{{.Repository}}:{{.Tag}}"],
               check=True, capture_output=True, text=True).stdout.split()


def free_disk(run: Callable = subprocess.run, room: Callable = lambda: ks.room_problem(ks.docker_run)) -> str | None:
    """R21, then R14's room: the problem that stops the release, or None.
    Never `docker volume prune`: the dev stack's and the panels' data live in volumes."""
    for ref in stale_images(release_images(run), local_images(run)):
        # Not forced: a tag a container still runs is refused and stays.
        run(["docker", "rmi", ref], check=False, stdout=subprocess.DEVNULL)
    for argv in (["docker", "buildx", "prune", "-f", "--keep-storage", BUILD_CACHE_KEEP],
                 ["docker", "builder", "prune", "-f"], ["docker", "image", "prune", "-f"]):
        run(argv, check=True, stdout=subprocess.DEVNULL)
    return room()
