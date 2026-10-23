"""Files, digests and metrics the bundle tools share (OPS-1-ad)."""
import contextlib
import fcntl
import hashlib
import os
import subprocess

# Where bundles are written and the ship ledger lives; BACKUP_BUNDLE_DIR moves it.
BUNDLE_DIR = os.environ.get("BACKUP_BUNDLE_DIR", "/var/backups/txnet/bundles")
LEDGER = ".shipped"
# node-exporter's textfile directory, bound at /textfile into pg-backup (H3).
TEXTFILE_MOUNT = "/textfile"
_CHUNK = 1 << 20


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(_CHUNK), b""):
            digest.update(chunk)
    return digest.hexdigest()


def path_digest(path):
    """A file's sha256, a directory's over every file's relative path and content; None when absent."""
    if os.path.isfile(path):
        return sha256_file(path)
    if not os.path.isdir(path):
        return None
    return hashlib.sha256("".join("%s %s\n" % pair for pair in sorted(tree_digests(path).items())).encode()).hexdigest()


def tree_digests(root):
    """{path relative to root: sha256} for every file under root."""
    found = {}
    for folder, _, files in os.walk(root):
        for name in files:
            full = os.path.join(folder, name)
            found[os.path.relpath(full, root)] = sha256_file(full)
    return found


def pipeline(script, *args):
    """A bash pipeline with pipefail: a failing stage fails the whole, not just the last."""
    done = subprocess.run(["bash", "-o", "pipefail", "-c", script, "_", *args], capture_output=True, text=True)
    if done.returncode != 0:
        raise RuntimeError(done.stderr.strip() or "pipeline failed (%d)" % done.returncode)
    return done.stdout


def textfile_dir(config):
    """The host directory bound at /textfile, or None."""
    for service in (config.get("services") or {}).values():
        for volume in service.get("volumes") or []:
            if volume.get("type") == "bind" and volume.get("target") == TEXTFILE_MOUNT:
                return volume["source"]
    return None


def write_metrics(directory, name, metrics):
    """metrics {name: value} as node-exporter's <name>.prom, replaced atomically."""
    if not directory or not os.path.isdir(directory):
        return
    path = os.path.join(directory, name + ".prom")
    with open(path + ".tmp", "w") as f:
        f.writelines("%s %s\n" % pair for pair in sorted(metrics.items()))
    os.replace(path + ".tmp", path)


@contextlib.contextmanager
def locked(directory, name):
    """One run at a time: a nightly bundle and a manual one never overlap."""
    os.makedirs(directory, exist_ok=True)
    with open(os.path.join(directory, "." + name + ".lock"), "w") as handle:
        try:
            fcntl.flock(handle, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError("another %s run holds the lock; wait for it" % name)
        yield


def read_ledger(directory):
    path = os.path.join(directory, LEDGER)
    return open(path).read() if os.path.exists(path) else ""


def passphrase_path(root, relative):
    """The passphrase file, refused when missing or empty: a bundle nobody can open is worse than none."""
    path = os.path.join(root, relative)
    if not os.path.isfile(path) or not open(path).read().strip():
        raise RuntimeError(
            "%s is missing: `openssl rand -base64 48 > %s`, then keep a copy off this server — "
            "without it no bundle can be opened" % (relative, relative))
    return path
