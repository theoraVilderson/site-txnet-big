#!/usr/bin/env python3
"""Where builds, the cluster and host downloads fetch from abroad, switched in one place
(ADR-0170, docs/platform/hosting/contract.mirrors.md).

    python3 scripts/mirrors/mirrors.py status            the active profile, and whether each source answers
    python3 scripts/mirrors/mirrors.py local|upstream    make that profile the committed mirrors.env

The profiles are scripts/mirrors/<name>.env. mirrors.env at the repo root is a
copy of one, read after .env by compose and the render, so it wins. A switch
takes on this host at once; production takes it at its next release.
"""
import os
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(ROOT / "scripts" / "bundle"))
from bundle_plan import parse_env  # noqa: E402

ACTIVE = "mirrors.env"
PROFILES_DIR = Path("scripts") / "mirrors"
KEYS = ("DOCKER_REGISTRY", "PKG_MIRROR", "APK_MIRROR")
NAME_KEY = "MIRRORS_PROFILE"
HEADER = """# Where image builds, the cluster's pulls and host downloads fetch from (ADR-0170).
# Written by `python3 scripts/mirrors/mirrors.py <profile>` from scripts/mirrors/<profile>.env;
# switch with that command, never by hand. Read after .env, so it wins.
"""
PROBE_TIMEOUT_S = 15
# One file each source must serve, under the profile's base (status only).
PROBES = (("DOCKER_REGISTRY", "https://{}/v2/library/alpine/manifests/3.19"),
          ("PKG_MIRROR", "{}/npm/express"),
          ("APK_MIRROR", "{}/v3.19/main/x86_64/APKINDEX.tar.gz"))
# A registry that wants a token answers 401 with its challenge, which docker pull follows.
ANSWERING = {"200", "401"}


class MirrorsError(Exception):
    pass


def profiles(root=ROOT):
    """The profile names, from the files under scripts/mirrors/."""
    return sorted(p.stem for p in (Path(root) / PROFILES_DIR).glob("*.env"))


def profile(name, root=ROOT):
    """A profile's values; refused unless it names exactly KEYS."""
    path = Path(root) / PROFILES_DIR / f"{name}.env"
    if not path.is_file():
        raise MirrorsError(f"no profile {name!r}: {', '.join(profiles(root)) or 'none'} exist")
    values = parse_env(path.read_text())
    if set(values) != set(KEYS):
        raise MirrorsError(f"{path} must set exactly {', '.join(KEYS)}")
    return values


def active(root=ROOT):
    """(profile name, values) as mirrors.env holds them."""
    values = parse_env((Path(root) / ACTIVE).read_text())
    return values.pop(NAME_KEY, None), values


def matching(root=ROOT):
    """The profile mirrors.env is a whole copy of, or None after a hand edit."""
    name, values = active(root)
    return name if name in profiles(root) and profile(name, root) == values else None


def switch(name, root=ROOT):
    """Writes profile `name` as mirrors.env; returns the variables whose value changed."""
    values = profile(name, root)
    path = Path(root) / ACTIVE
    before = active(root)[1] if path.exists() else {}
    path.write_text(HEADER + f"{NAME_KEY}={name}\n" + "".join(f"{k}={values[k]}\n" for k in KEYS))
    return sorted(k for k in KEYS if before.get(k) != values[k])


def answers(url):
    """The HTTP status a source gives, straight (no proxy: the servers have none), or the error."""
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        return str(opener.open(urllib.request.Request(url, method="HEAD"), timeout=PROBE_TIMEOUT_S).status)
    except urllib.error.HTTPError as e:
        return str(e.code)
    except OSError as e:
        return f"unreachable ({e})"


def status(root=ROOT):
    name, values = active(root)
    print(f"{ACTIVE}: {name if matching(root) else f'{name}, edited by hand (switch again to restore)'}")
    for key, template in PROBES:
        base = values.get(key, "")
        code = answers(template.format(base)) if base else ""
        verdict = "-" if not base else "answers" if code in ANSWERING else f"DOWN ({code})"
        print(f"  {key:16} {base or '(upstream)':48} {verdict}")


def main(argv):
    if len(argv) != 1 or argv[0] not in ("status", *profiles()):
        sys.exit(__doc__.split("\n\n")[1])
    if argv[0] == "status":
        status()
        return
    changed = switch(argv[0])
    print(f"{ACTIVE} is now {argv[0]}: {', '.join(changed) or 'nothing'} changed")
    if changed:
        print("this host builds with it now; production takes it at the next release "
              f"(commit {ACTIVE}, push, release)")


if __name__ == "__main__":
    try:
        main(sys.argv[1:])
    except MirrorsError as e:
        sys.exit(f"mirrors.py: {e}")
