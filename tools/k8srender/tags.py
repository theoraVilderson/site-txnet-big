"""K8 (OPS-1-o-y): an image's tag is the fingerprint of what it is built from.

A release is the commit (K16), but an image is its source: the git trees of its
build context and extra contexts, its Dockerfile and its stage, at HEAD. A
commit that leaves a service's source alone leaves its tag alone, so that
service neither rolls nor pulls. Build args are left out on purpose: they name
where a build fetches from (a mirror, a proxy) and differ between hosts.
"""
import hashlib
import subprocess
from pathlib import Path

from .objects import RenderError

# Short enough to read in `kubectl get pods`, long enough never to collide.
TAG_LENGTH = 12


def _object_id(repo: Path, path: Path) -> str:
    """The id git gives `path` at HEAD: a tree for a directory, a blob for a file."""
    rel = path.resolve().relative_to(repo.resolve()).as_posix()
    run = subprocess.run(["git", "-C", str(repo), "rev-parse", f"HEAD:{rel}" if rel != "." else "HEAD^{tree}"],
                         capture_output=True, text=True)
    if run.returncode != 0:
        raise RenderError(f"{rel}: not in git at HEAD, so no image can be tagged by it")
    return run.stdout.strip()


def _fingerprint(repo: Path, build: dict) -> str:
    context = Path(build["context"])
    parts = [f"context {_object_id(repo, context)}", f"target {build.get('target') or ''}"]
    dockerfile = context / (build.get("dockerfile") or "Dockerfile")
    if not dockerfile.resolve().is_relative_to(context.resolve()):
        parts.append(f"dockerfile {_object_id(repo, dockerfile)}")
    for name, path in sorted((build.get("additional_contexts") or {}).items()):
        parts.append(f"extra {name} {_object_id(repo, Path(path))}")
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()[:TAG_LENGTH]


def content_tags(services: dict, repo: Path) -> dict[str, str]:
    """Each service compose builds, mapped to the tag of its source at HEAD."""
    return {name: _fingerprint(repo, service["build"]) for name, service in sorted(services.items())
            if service.get("build")}
