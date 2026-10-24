"""K5: which files the render reads as secret, and where their sealed copies
live (contract.secrets.md). Sealing and opening are tools/k8s_secrets.py's."""
from pathlib import Path, PurePosixPath

from .objects import RenderError
from .tables import SECRET_DIR

# Committed, SOPS-encrypted to the node's age key; one file per secret file.
SEALED_DIR = "k8s/sealed"
SEALED_SUFFIX = ".sops"
# B5: the age key rides in the bundle, so a bundle's passphrase sealed in the
# repo would let a bundle open itself. It stays off the server, never here.
NEVER_SEALED = {"dev-docker/secrets/backup-bundle-passphrase"}


def sealed_path(rel: str) -> str:
    """Where `rel`'s sealed copy is. A leading dot is spelt `dot`: `.env*` is
    git-ignored, so `.env.prod.sops` would never be committed."""
    path = PurePosixPath(rel)
    name = "dot" + path.name[1:] if path.name.startswith(".") else path.name
    return str(PurePosixPath(SEALED_DIR, path.parent, name + SEALED_SUFFIX))


def secret_files(model: dict, repo: Path) -> list[str]:
    """Repo-relative paths of the files a render of `model` reads as secret:
    each bound file under dev-docker/secrets/ (K7) and each compose `secrets:`
    file a service mounts (K11). Derived, so a key bound tomorrow is sealed too."""
    found = set()
    for name, service in model["services"].items():
        for entry in service.get("volumes") or []:
            rel = _relative(entry.get("source"), repo) if entry.get("type") == "bind" else None
            if rel and rel.startswith(SECRET_DIR + "/"):
                found.add(rel)
        for entry in service.get("secrets") or []:
            declared = (model.get("secrets") or {}).get(entry["source"]) or {}
            rel = _relative(declared.get("file"), repo)
            if not rel:
                raise RenderError(f"{name}: secret {entry['source']} is not a file in the checkout (K5)")
            found.add(rel)
    refused = sorted(found & NEVER_SEALED)
    if refused:
        raise RenderError(f"{', '.join(refused)} is mounted by a service, and is never sealed (B5)")
    return sorted(found)


def read_secret(path: Path, repo: Path, sealed_root: Path | None) -> bytes:
    """A secret file's bytes: from the opened sealed copies when the render has
    them, and then never from the checkout (K5: decrypted only in memory)."""
    if sealed_root is None:
        return path.read_bytes()
    rel = _relative(str(path), repo)
    opened = sealed_root / rel if rel else None
    if not opened or not opened.is_file():
        raise RenderError(f"{rel or path} is not sealed (K5): `scripts/prod.k8s.sh secrets seal` it")
    return opened.read_bytes()


def _relative(source: str | None, repo: Path) -> str | None:
    try:
        return str(Path(source).relative_to(repo)) if source else None
    except ValueError:
        return None
