#!/usr/bin/env python3
"""The registry keeps the last IMAGES_KEPT releases' images (hosting R22, OPS-1-ah-m).

After a deploy, `release.py`'s `close` step renders each kept release's commit,
as `release_reach` renders production's, and deletes every other tag of the
repositories those releases use. A delete frees no space by itself: registry:2
returns it only on `registry garbage-collect`, run by hand in Arvan's console
(contract.release-disk.md R22).

    python3 tools/release_registry.py [--dry-run] <history...>    the same, by hand
"""
import base64
import json
import sys
import tempfile
import urllib.error
import urllib.request
from collections import defaultdict
from pathlib import Path
from typing import Callable

sys.path.insert(0, str(Path(__file__).parent))
from k8s_release import IMAGES_KEPT  # noqa: E402
import release_reach as rr  # noqa: E402
from release_disk import repository  # noqa: E402

DOCKER_CONFIG = Path.home() / ".docker" / "config.json"
REQUEST_TIMEOUT_S = 30
# Index types first: the digest a tag resolves to is what a DELETE by digest removes.
MANIFEST_TYPES = ", ".join(("application/vnd.oci.image.index.v1+json",
                            "application/vnd.docker.distribution.manifest.list.v2+json",
                            "application/vnd.oci.image.manifest.v1+json",
                            "application/vnd.docker.distribution.manifest.v2+json"))
GC_COMMAND = "registry garbage-collect --delete-untagged /etc/distribution/config.yml"


class Registry:
    """registry:2's API with this host's push login (`docker login`), never through a proxy."""

    def __init__(self, host: str):
        auths = json.loads(DOCKER_CONFIG.read_text()).get("auths", {})
        if not auths.get(host, {}).get("auth"):
            raise RuntimeError(f"no `docker login` for {host} on this host")
        self.host, self._auth = host, auths[host]["auth"]
        self._open = urllib.request.build_opener(urllib.request.ProxyHandler({})).open

    def _call(self, path: str, method: str = "GET"):
        request = urllib.request.Request(f"https://{self.host}/v2/{path}", method=method,
                                         headers={"Authorization": "Basic " + self._auth, "Accept": MANIFEST_TYPES})
        return self._open(request, timeout=REQUEST_TIMEOUT_S)

    def tags(self, repo: str) -> list[str]:
        with self._call(f"{repo}/tags/list") as response:
            return json.load(response).get("tags") or []

    def digest(self, repo: str, tag: str) -> str:
        with self._call(f"{repo}/manifests/{tag}", "HEAD") as response:
            return response.headers["Docker-Content-Digest"]

    def delete(self, repo: str, digest: str) -> None:
        try:
            self._call(f"{repo}/manifests/{digest}", "DELETE").close()
        except urllib.error.HTTPError as error:
            if error.code != 404:  # gone already: another tag on it was deleted first
                raise


def split(image: str) -> tuple[str, str, str]:
    """`host/path/name:tag` -> (host, path/name, tag)."""
    name = repository(image)
    host, _, path = name.partition("/")
    return host, path, image[len(name) + 1:]


def kept_images(history: list[str], render: Callable[[str], dict[str, str]]) -> set[str]:
    """Every image the last IMAGES_KEPT releases run; a commit that fails to render raises."""
    return {image for commit in history[-IMAGES_KEPT:] for image in render(commit).values()}


def plan(kept: set[str], registry) -> dict[tuple[str, str], list[str]]:
    """{(repo, digest): its stale tags} on `registry.host`. A digest a kept tag also
    resolves to is never planned: a DELETE by digest removes every tag on it."""
    kept_tags = defaultdict(set)
    for image in kept:
        host, repo, tag = split(image)
        if host == registry.host:
            kept_tags[repo].add(tag)
    deletions = defaultdict(list)
    for repo, keep in sorted(kept_tags.items()):
        kept_digests = {registry.digest(repo, tag) for tag in keep}
        for tag in sorted(set(registry.tags(repo)) - keep):
            digest = registry.digest(repo, tag)
            if digest not in kept_digests:
                deletions[(repo, digest)].append(tag)
    return deletions


def prune(history: list[str], render: Callable[[str], dict[str, str]], registry, delete: bool = True) -> dict:
    if not history:
        return {}
    deletions = plan(kept_images(history, render), registry)
    for repo, digest in deletions if delete else ():
        registry.delete(repo, digest)
    return deletions


def render_images(commit: str) -> dict[str, str]:
    with tempfile.TemporaryDirectory() as out:
        return rr.images_of(rr.render_commit(commit, Path(out)))


def registry_host(history: list[str]) -> str:
    """The host the newest release pushes to, from its own render."""
    hosts = {split(image)[0] for image in render_images(history[-1]).values() if "/txnet/" in image}
    if len(hosts) != 1:
        raise RuntimeError(f"the release names {len(hosts)} registries for txnet images, expected one")
    return hosts.pop()


def after_release(history: list[str], delete: bool = True) -> None:
    """`close`'s step: a failure is reported, never raised; the release is already live."""
    try:
        deletions = prune(history, render_images, Registry(registry_host(history)), delete)
    except Exception as error:  # noqa: BLE001 — any failure only leaves extra tags behind
        print(f"registry retention skipped, nothing deleted ({error}) (R22)")
        return
    tags = sum(len(t) for t in deletions.values())
    if not delete:
        for (repo, _), stale in sorted(deletions.items()):
            print(f"  would delete {repo}:{','.join(stale)}")
    print(f"registry: {tags} tag(s) of releases before the last {IMAGES_KEPT} "
          f"{'deleted' if delete else 'to delete'} (R22)")
    if tags and delete:
        print(f"  space returns after, in Arvan's console: {GC_COMMAND}")


if __name__ == "__main__":
    dry = "--dry-run" in sys.argv[1:]
    after_release([a for a in sys.argv[1:] if a != "--dry-run"], delete=not dry)
