"""K8, R12 (OPS-1-o-y): an image's tag is the fingerprint of what it is built from.

A release is the commit (K16), but an image is its source, read from git at
HEAD so the node computes the same tag without npm or Nx:

- an app of an Nx workspace (`APP_NAME` in a context holding nx.json): the
  workspace minus the projects the app does not import and minus the seed
  scripts only db-migrate's stage runs; its image is node_modules and dist/<app>;
- any other image: what its Dockerfile copies (`COPY`/`ADD`, not `--from`), all
  of the context when it copies `.` or a path the file cannot name statically.

Its Dockerfile, extra contexts and target stage count too. Build args are left
out: they name a mirror or a proxy and differ between hosts.
"""
import hashlib
import json
import re
import subprocess
from pathlib import Path, PurePosixPath

from .objects import RenderError

# Short enough to read in `kubectl get pods`, long enough never to collide.
TAG_LENGTH = 12
# Read only by `node prisma/seed.js`, which db-migrate's stage runs; no app's
# image holds them (txnet-backend/Dockerfile copies node_modules and dist/<app>).
SEED_ONLY = re.compile(r"^prisma/seed[^/]*\.js$")
# A workspace import: `from '@txnet-backend/shared-core/...'` names the project.
_IMPORT = r"['\"](@[A-Za-z0-9_-]+/[A-Za-z0-9_-]+)"
_COPY = re.compile(r"^\s*(COPY|ADD)\s+(.*)$", re.IGNORECASE)


def _git(repo: Path, *argv: str) -> str:
    run = subprocess.run(["git", "-C", str(repo), *argv], capture_output=True, text=True)
    if run.returncode != 0:
        raise RenderError(f"git {' '.join(argv)}: {run.stderr.strip()}")
    return run.stdout


def _rel(repo: Path, path: Path) -> str:
    """`path` relative to the repo, "" for the repo itself."""
    rel = path.resolve().relative_to(repo.resolve()).as_posix()
    return "" if rel == "." else rel


def _object_id(repo: Path, rel: str) -> str:
    """The id git gives `rel` at HEAD: a tree for a directory, a blob for a file."""
    run = subprocess.run(["git", "-C", str(repo), "rev-parse", f"HEAD:{rel}" if rel else "HEAD^{tree}"],
                         capture_output=True, text=True)
    if run.returncode != 0:
        raise RenderError(f"{rel or '.'}: not in git at HEAD, so no image can be tagged by it")
    return run.stdout.strip()


def _blobs(repo: Path, rel: str) -> dict[str, str]:
    """{path under `rel`: blob id} for every file below `rel` at HEAD."""
    out = _git(repo, "ls-tree", "-r", "HEAD", "--", rel or ".")
    prefix = f"{rel}/" if rel else ""
    return {line.split("\t", 1)[1][len(prefix):]: line.split()[2] for line in out.splitlines()}


def _show(repo: Path, rel: str) -> str:
    """`rel`'s content at HEAD."""
    return _git(repo, "show", f"HEAD:{rel}")


def _jsonc(text: str) -> dict:
    """tsconfig.json allows // comments; nothing else of JSONC is used there."""
    return json.loads(re.sub(r"^\s*//.*$|(?<=[,{\[])\s*//[^\n]*", "", text, flags=re.MULTILINE))


def _workspace_projects(repo: Path, context: str, files: dict[str, str]) -> tuple[dict, dict]:
    """({project name: root}, {root: roots it imports, transitively})."""
    roots = {str(PurePosixPath(f).parent): f for f in files if PurePosixPath(f).name == "project.json"}
    names = {json.loads(_show(repo, f"{context}/{f}"))["name"]: root for root, f in roots.items()}
    paths = _jsonc(_show(repo, f"{context}/tsconfig.base.json")).get("compilerOptions", {}).get("paths", {})
    alias_root = {}
    for alias, targets in paths.items():
        target = PurePosixPath(targets[0].removeprefix("./"))
        alias_root[alias] = next((r for r in roots if target.is_relative_to(r)), None)
    imports = {}
    for root in roots:
        found = {m.strip("'\"") for m in _imports(repo, f"{context}/{root}")}
        imports[root] = {alias_root[a] for a in found if alias_root.get(a)} - {root}
    closure = {}
    for root in roots:
        seen, todo = set(), [root]
        while todo:
            for dep in imports[todo.pop()] - seen:
                seen.add(dep)
                todo.append(dep)
        closure[root] = seen
    return names, closure


def _imports(repo: Path, rel: str) -> list[str]:
    """The workspace aliases `rel`'s files import at HEAD. `git grep` exits 1
    when nothing matches: that is an answer, not a failure."""
    run = subprocess.run(["git", "-C", str(repo), "grep", "-h", "-o", "-E", _IMPORT, "HEAD", "--", rel],
                         capture_output=True, text=True)
    if run.returncode not in (0, 1):
        raise RenderError(f"git grep in {rel}: {run.stderr.strip()}")
    return run.stdout.splitlines()


def _app_inputs(repo: Path, context: str, app: str, files: dict[str, str]) -> list[str]:
    names, closure = _workspace_projects(repo, context, files)
    if app not in names:
        raise RenderError(f"{context}: no Nx project named {app!r} (APP_NAME)")
    keep = {names[app], *closure[names[app]]}
    others = [r for r in closure if r not in keep]
    return [f"{f} {blob}" for f, blob in sorted(files.items())
            if not SEED_ONLY.match(f) and not any(PurePosixPath(f).is_relative_to(r) for r in others)]


def _copied_inputs(repo: Path, context: str, dockerfile: str) -> list[str] | None:
    """The git ids of what the Dockerfile copies from the context, or None for all of it."""
    sources = []
    for line in _show(repo, dockerfile).splitlines():
        found = _COPY.match(line)
        if not found or "--from=" in found.group(2):
            continue
        words = [w for w in found.group(2).split() if not w.startswith("--")]
        if found.group(2).lstrip().startswith("[") or len(words) < 2:
            return None  # the JSON form, or a line this cannot read: all of the context
        sources += words[:-1]
    if any(s in (".", "./") or "$" in s or "*" in s for s in sources):
        return None
    return [f"copy {s} {_object_id(repo, str(PurePosixPath(context, s.rstrip('/'))))}" for s in sorted(set(sources))]


def _fingerprint(repo: Path, build: dict) -> str:
    context_path = Path(build["context"])
    context = _rel(repo, context_path)
    dockerfile_path = context_path / (build.get("dockerfile") or "Dockerfile")
    parts = [f"dockerfile {_object_id(repo, _rel(repo, dockerfile_path))}", f"target {build.get('target') or ''}"]
    app = (build.get("args") or {}).get("APP_NAME")
    files = _blobs(repo, context) if app else {}
    if "nx.json" in files:
        parts += _app_inputs(repo, context, app, files)
    else:
        copied = _copied_inputs(repo, context, _rel(repo, dockerfile_path))
        parts += copied if copied is not None else [f"context {_object_id(repo, context)}"]
    for name, path in sorted((build.get("additional_contexts") or {}).items()):
        parts.append(f"extra {name} {_object_id(repo, _rel(repo, Path(path)))}")
    return hashlib.sha256("\n".join(parts).encode()).hexdigest()[:TAG_LENGTH]


def content_tags(services: dict, repo: Path) -> dict[str, str]:
    """Each service compose builds, mapped to the tag of its source at HEAD."""
    return {name: _fingerprint(repo, service["build"]) for name, service in sorted(services.items())
            if service.get("build")}
