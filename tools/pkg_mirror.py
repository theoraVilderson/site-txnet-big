#!/usr/bin/env python3
"""A download from abroad, through the package mirror (Nexus) when one is set.

    python3 tools/pkg_mirror.py <url>     prints the URL to fetch

The mirror is mirrors.env's PKG_MIRROR (ADR-0170; the environment's wins), the
same one image builds use. Each upstream host is a raw proxy repo that keeps the host's path,
so the rewrite is a prefix swap; the caller's sha256 check still applies. Empty
PKG_MIRROR fetches from upstream as before.
"""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "scripts" / "bundle"))
from bundle_plan import parse_env  # noqa: E402
from k8srender.tables import MIRRORS_ENV  # noqa: E402

# upstream prefix -> the mirror's repo for it (the Nexus repo names)
REPOS = {
    "https://github.com/": "github",
    "https://raw.githubusercontent.com/": "github-raw",
    "https://download.mikrotik.com/": "mikrotik",
    "https://downloads.sourceforge.net/": "sourceforge",
}


def configured(root=ROOT, environ=os.environ):
    """PKG_MIRROR from the environment (set empty: upstream for this run), else from root/mirrors.env, else empty."""
    if "PKG_MIRROR" in environ:
        return environ["PKG_MIRROR"]
    env = Path(root) / MIRRORS_ENV
    return parse_env(env.read_text()).get("PKG_MIRROR", "") if env.exists() else ""


def environ(root=ROOT):
    """mirrors.env's variables, for a subprocess whose tree may predate the file (ADR-0170):
    compose takes the shell's values over every env file, old trees' included."""
    return {k: v for k, v in parse_env((Path(root) / MIRRORS_ENV).read_text()).items() if k != "MIRRORS_PROFILE"}


def mirrored(url, mirror):
    """url through mirror's repo for its host; url itself when mirror is empty."""
    if not mirror:
        return url
    for prefix, repo in REPOS.items():
        if url.startswith(prefix):
            # Nexus reads a bare `+` (k3s tags) as a space
            return "%s/%s/%s" % (mirror.rstrip("/"), repo, url[len(prefix):].replace("+", "%2B"))
    raise ValueError("the package mirror has no repo for %s" % url)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__.strip().splitlines()[2].strip())
    print(mirrored(sys.argv[1], configured()))
