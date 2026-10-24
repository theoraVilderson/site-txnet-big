"""K7: a compose service's mounts -> pod volumes, container mounts and the
objects behind them (claims, file Secrets, file ConfigMaps)."""
from pathlib import Path, PurePosixPath

from .monitoring import rewrite
from .objects import RenderError, dns_name, hashed
from .sealed import read_secret
from .tables import (BAKED_BINDS, BIND_CLAIMS, DEFAULT_VOLUME_SIZE, DOCKER_HOST_BINDS, POD_LOCAL_VOLUMES,
                     SECRET_DIR, VOLUME_SIZES)

# Where compose mounts a `secrets:` entry that names no absolute target.
_SECRETS_ROOT = "/run/secrets"


class Mounts:
    """What one pod mounts, collected across its containers (K3's sidecar shares it).
    `declared` is the model's top-level `configs:` and `secrets:` (K7, K11);
    `sealed_root`, when given, is where the secret files were opened (K5)."""

    def __init__(self, repo: Path, declared: dict | None = None, sealed_root: Path | None = None):
        self.repo = repo
        self.declared = declared or {}
        self.sealed_root = sealed_root
        self.volumes: dict[str, dict] = {}
        self.objects: dict[str, dict] = {}

    def for_service(self, name: str, service: dict) -> list[dict]:
        """The container's volumeMounts; the pod's volumes accumulate on self."""
        mounts = []
        for entry in service.get("volumes") or []:
            mount = self._mount(name, entry)
            if mount:
                mounts.append(mount)
        for kind in ("configs", "secrets"):
            mounts += [self._declared(name, kind, entry) for entry in service.get(kind) or []]
        for path in _tmpfs_paths(service.get("tmpfs")):
            mounts.append(self._memory(f"tmp-{dns_name(path)}", path, None))
        if service.get("shm_size"):
            mounts.append(self._memory("dshm", "/dev/shm", str(service["shm_size"])))
        return mounts

    def _mount(self, service: str, entry: dict) -> dict | None:
        target, kind = entry["target"], entry["type"]
        if kind == "volume" and not entry.get("source"):
            # Dev's `/app/node_modules` under its source tree (docker-compose.dev.yml):
            # in a prod pod it would hide the image's own copy (OPS-1-o-v).
            raise RenderError(f"{service}: anonymous volume at {target} hides the image's own files (K7)")
        if kind == "volume":
            return self._named(entry["source"], target, entry)
        if kind == "bind":
            return self._bind(service, entry)
        if kind == "tmpfs":
            return self._memory(f"tmp-{dns_name(target)}", target, None)
        raise RenderError(f"{service}: volume type {kind!r} at {target}")

    def _named(self, source: str, target: str, entry: dict) -> dict:
        name = dns_name(source)
        if source in POD_LOCAL_VOLUMES:
            self.volumes[name] = {"name": name, "emptyDir": {}}
        else:
            self.volumes[name] = {"name": name, "persistentVolumeClaim": {"claimName": name}}
            self.objects[f"pvc/{name}"] = claim(source)
        return _mount(name, target, entry)

    def _bind(self, service: str, entry: dict) -> dict | None:
        source = Path(entry["source"])
        rel = _repo_relative(source, self.repo)
        if str(source) in DOCKER_HOST_BINDS or rel in BAKED_BINDS:
            return None
        if rel in BIND_CLAIMS:
            return self._named(BIND_CLAIMS[rel], entry["target"], entry)
        if rel is None:
            name = f"host-{dns_name(str(source)) or 'root'}"  # `/` itself: node-exporter's rootfs
            self.volumes[name] = {"name": name, "hostPath": {"path": str(source), "type": "DirectoryOrCreate"}}
            return _mount(name, entry["target"], entry)
        # A secret file is a file even where only its sealed copy exists (the node, K5).
        if not (source.is_file() or (self.sealed_root and rel.startswith(SECRET_DIR + "/"))):
            # A source tree is dev's alone (docker-compose.dev.yml): here it would
            # run the checkout instead of the image (OPS-1-o-v).
            raise RenderError(f"{service}: bound directory {rel} at {entry['target']} is not baked (K7)")
        return self._file(rel, source, entry)

    def _file(self, rel: str, source: Path, entry: dict) -> dict:
        key = source.name
        is_secret = rel.startswith(SECRET_DIR + "/")
        base = dns_name(("secret-" if is_secret else "cfg-") + key)
        data = {key: read_secret(source, self.repo, self.sealed_root) if is_secret else source.read_text()}
        obj = hashed("Secret" if is_secret else "ConfigMap", base, data)
        self.objects[f"file/{base}"] = obj
        ref = {"secret": {"secretName": obj["metadata"]["name"]}} if is_secret else \
            {"configMap": {"name": obj["metadata"]["name"]}}
        self.volumes[base] = {"name": base, **ref}
        return {**_mount(base, entry["target"], entry), "subPath": key}

    def _declared(self, service: str, kind: str, entry: dict) -> dict:
        """A compose `configs:` entry is a ConfigMap, a `secrets:` entry a Secret,
        mounted read-only at the target compose gives it (K11). A config this
        service reads differently on Kubernetes is rewritten (monitoring.py)."""
        source = entry["source"]
        declared = (self.declared.get(kind) or {}).get(source)
        if not declared or not declared.get("file"):
            raise RenderError(f"{service}: {kind} {source} is not declared from a file (K11)")
        default_root = _SECRETS_ROOT if kind == "secrets" else "/"
        target = str(PurePosixPath(default_root, entry.get("target") or source))
        path, key = Path(declared["file"]), PurePosixPath(target).name
        if kind == "secrets":
            base = dns_name(f"secret-{source}")
            obj = hashed("Secret", base, {key: read_secret(path, self.repo, self.sealed_root)})
            ref = {"secret": {"secretName": obj["metadata"]["name"]}}
        else:
            base = dns_name(f"cfg-{source}")
            obj = hashed("ConfigMap", base, {key: rewrite(service, target, path.read_text())})
            ref = {"configMap": {"name": obj["metadata"]["name"]}}
        self.objects[f"file/{base}"] = obj
        self.volumes[base] = {"name": base, **ref}
        return {"name": base, "mountPath": target, "subPath": key, "readOnly": True}

    def _memory(self, name: str, path: str, size: str | None) -> dict:
        empty = {"medium": "Memory"}
        if size:
            empty["sizeLimit"] = size
        self.volumes[name] = {"name": name, "emptyDir": empty}
        return {"name": name, "mountPath": path}


def claim(volume: str) -> dict:
    """K7: one ReadWriteOnce claim per named volume, shared by every pod that mounts it."""
    return {
        "apiVersion": "v1", "kind": "PersistentVolumeClaim",
        "metadata": {"name": dns_name(volume)},
        "spec": {"accessModes": ["ReadWriteOnce"],
                 "resources": {"requests": {"storage": VOLUME_SIZES.get(volume, DEFAULT_VOLUME_SIZE)}}},
    }


def _mount(name: str, target: str, entry: dict) -> dict:
    mount = {"name": name, "mountPath": target}
    if entry.get("read_only"):
        mount["readOnly"] = True
    return mount


def _repo_relative(source: Path, repo: Path) -> str | None:
    try:
        return str(source.relative_to(repo))
    except ValueError:
        return None


def _tmpfs_paths(tmpfs) -> list[str]:
    """Compose's `tmpfs:` (a string or a list of `path[:options]`) as paths."""
    entries = [tmpfs] if isinstance(tmpfs, str) else tmpfs or []
    return [e.split(":", 1)[0] for e in entries]
