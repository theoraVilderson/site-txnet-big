#!/usr/bin/env python3
"""A release's reach: what it changes in production, and so what proves it (hosting
contract.release-reach.md, ADR-0169, OPS-1-ah-l).

    python3 tools/release_reach.py --from REF   HEAD's reach over REF, its lane and the twin's checks

Production's release and HEAD are each rendered by their own `k8s_render.py`
with this host's env files, so the two differ only by code. An image whose tag
moved is that service's code (R12 tags by source); any other difference is the
platform's own shape. A compose service says what proves it with `x-release`:

    x-release: {lane: quick}         a change to it alone skips the twin
    x-release: {checks: [panels]}    a change to it adds that twin check

Nothing here names a service: the next frontend or store declares itself.
"""
import argparse
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
import k8s_render  # noqa: E402
from k8srender.tables import STACKS  # noqa: E402
from k8s_staging_data import RENDERED_DIRS  # noqa: E402

QUICK, TWIN = "quick", "twin"
# The twin's checks, in the order it runs them; `ready` always runs.
TWIN_CHECKS = ("ready", "panels", "roll", "stores")
ALWAYS = ("ready",)
DECLARATION = "x-release"
_DECLARED_KEYS = {"lane", "checks"}
# Both renders get the same node address: it is configuration, not code.
REACH_HOST_GATEWAY = "127.0.0.1"
# Production's secrets reach the rendered Secrets: memory only, never disk.
SHM = Path("/dev/shm")


class ReachError(Exception):
    pass


@dataclass(frozen=True)
class Reach:
    """Services whose image moved, and the rendered files that differ otherwise."""
    images: frozenset[str]
    manifests: tuple[str, ...]


def _untagged(image: str) -> str:
    """`image` without its tag; a registry's `host:port` is not one."""
    name, _, tag = image.rpartition(":")
    return name if name and "/" not in tag else image


def _containers(node):
    """Every container spec (name + image) under a parsed manifest."""
    if isinstance(node, dict):
        if isinstance(node.get("name"), str) and isinstance(node.get("image"), str):
            yield node
        for value in node.values():
            yield from _containers(value)
    elif isinstance(node, list):
        for value in node:
            yield from _containers(value)


def _parsed(text: str) -> list:
    return [doc for doc in yaml.safe_load_all(text) if doc is not None]


def images_of(files: dict[str, str]) -> dict[str, str]:
    """{container: image} over rendered files; a container is named by its compose service."""
    return {c["name"]: c["image"] for text in files.values() for doc in _parsed(text) for c in _containers(doc)}


def _shape(text: str) -> list:
    """A rendered file with every image's tag removed: what is left is the platform's shape."""
    docs = _parsed(text)
    for doc in docs:
        for container in _containers(doc):
            container["image"] = _untagged(container["image"])
    return docs


def compare(old: dict[str, str], new: dict[str, str]) -> Reach:
    """Production's render against the release's."""
    old_images, new_images = images_of(old), images_of(new)
    moved = {name for name, image in new_images.items() if name in old_images and old_images[name] != image}
    differ = sorted(path for path in old.keys() | new.keys()
                    if path not in old or path not in new or _shape(old[path]) != _shape(new[path]))
    return Reach(images=frozenset(moved), manifests=tuple(differ))


def declared_of(services: dict) -> dict[str, dict]:
    """{service: its x-release} from a compose model; a misspelling is refused, since
    one read as nothing would quietly take a check away."""
    declared = {}
    for name, service in services.items():
        value = service.get(DECLARATION)
        if value is None:
            continue
        problems = sorted(set(value) - _DECLARED_KEYS) if isinstance(value, dict) else [repr(value)]
        if isinstance(value, dict):
            if value.get("lane", QUICK) != QUICK:
                problems.append(f"lane {value['lane']!r}")
            checks = value.get("checks", [])
            if not isinstance(checks, list) or set(checks) - set(TWIN_CHECKS):
                problems.append(f"checks {checks!r}")
        if problems:
            raise ReachError(f"{name}: {DECLARATION} {', '.join(problems)} (lane: {QUICK}; "
                             f"checks: {', '.join(TWIN_CHECKS)})")
        declared[name] = value
    return declared


def lane(reach: Reach, declared: dict[str, dict]) -> str:
    """Quick when the platform's shape is unchanged and every moved image declares it."""
    if reach.manifests:
        return TWIN
    quick = all(declared.get(name, {}).get("lane") == QUICK for name in reach.images)
    return QUICK if quick else TWIN


def checks(reach: Reach, declared: dict[str, dict]) -> tuple[str, ...]:
    """The twin's checks: every one for a change of shape, else `ready` and what the moved images declare."""
    if reach.manifests:
        return TWIN_CHECKS
    wanted = set(ALWAYS).union(*(declared.get(name, {}).get("checks", []) for name in reach.images))
    return tuple(c for c in TWIN_CHECKS if c in wanted)


def _borrowed(root: Path) -> list[str]:
    """What git ignores here and a render may read (env files, secret files): an old
    commit's worktree lacks them. Never bytecode, nor the render's own output."""
    out = subprocess.run(["git", "-C", str(root), "ls-files", "--others", "--ignored", "--exclude-standard",
                          "--directory"], check=True, text=True, capture_output=True).stdout
    paths = [line.rstrip("/") for line in out.splitlines() if line]
    return [p for p in paths if "__pycache__" not in p.split("/") and not any(
        p == d or p.startswith(f"{d}/") for d in RENDERED_DIRS)]


def render_tree(tree: Path, out: Path) -> dict[str, str]:
    """`tree`'s own render of every stack into `out`, read back as {stack/path: text}.
    A render from before `--stack` (2026-10-23 and earlier) renders the main stack
    alone, so the monitoring stack reads as added: a change of shape, the full twin."""
    render = tree / "tools" / "k8s_render.py"
    stacks = STACKS if "--stack" in render.read_text() else ("main",)
    for stack in stacks:
        chosen = ["--stack", stack] if len(stacks) > 1 else []
        subprocess.run(["python3", str(render), str(out / stack), *chosen, "--host-gateway", REACH_HOST_GATEWAY],
                       check=True, stdout=subprocess.DEVNULL)
    return {path.relative_to(out).as_posix(): path.read_text() for path in sorted(out.rglob("*.yaml"))}


def render_commit(commit: str, out: Path) -> dict[str, str]:
    """`commit` rendered from a worktree that borrows what this checkout keeps out of git."""
    tree = out / "tree"
    subprocess.run(["git", "-C", str(ROOT), "worktree", "add", "--quiet", "--detach", str(tree), commit], check=True)
    try:
        for name in _borrowed(ROOT):
            if (tree / name).parent.is_dir() and not (tree / name).exists():
                (tree / name).symlink_to(ROOT / name)
        return render_tree(tree, out / "rendered")
    finally:
        subprocess.run(["git", "-C", str(ROOT), "worktree", "remove", "--force", str(tree)], check=False)


def measure(base: str) -> tuple[Reach, dict[str, dict]]:
    """HEAD's reach over `base`, and its declarations: both from this checkout, which a release requires clean."""
    with tempfile.TemporaryDirectory(dir=SHM if SHM.is_dir() else None) as work:
        os.chmod(work, 0o700)
        reach = compare(render_commit(base, Path(work) / "base"), render_tree(ROOT, Path(work) / "head"))
    model = k8s_render.load_model(STACKS["main"], list(STACKS["main"].env_files), {})
    return reach, declared_of(model["services"])


def describe(reach: Reach, declared: dict[str, dict]) -> str:
    moved = ", ".join(sorted(reach.images)) or "none"
    shape = ", ".join(reach.manifests) or "unchanged"
    return (f"images moved: {moved}\nplatform shape: {shape}\n"
            f"lane: {lane(reach, declared)}; twin checks: {', '.join(checks(reach, declared))}")


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--from", dest="base", required=True, help="production's release")
    args = parser.parse_args(argv)
    try:
        print(describe(*measure(args.base)))
    except (ReachError, subprocess.CalledProcessError, k8s_render.RenderError) as error:
        print(f"release_reach: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
