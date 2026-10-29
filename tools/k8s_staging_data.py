#!/usr/bin/env python3
"""Production's data in the staging cluster (hosting R14, ADR-0166 point 3, OPS-1-ah-b).

`scripts/staging.sh restore`, after `up`: production's newest bundle and its
passphrase are copied into memory; the cluster is deployed at the bundle's
commit from a worktree, exactly as production runs it (B10: a restore goes
into a deployed cluster); then `backup.py restore --stack k8s --replace`.

Everything that opens production's secrets stays in SHM_DIR (/dev/shm): the
bundle and what it decrypts to, the passphrase, the age key (linked from the
place sops reads it), the worktree with its rendered manifests and env files.
`down` removes all of it, and a reboot does too.

    STAGING_PROD_SSH      production's server, as ssh names it (root@host)
    STAGING_PROD_SSH_KEY  the identity that reaches it
"""
import os
import shlex
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "tools"))
sys.path.insert(0, str(ROOT / "scripts" / "bundle"))
import bundle_plan as bp  # noqa: E402
import bundle_restore as br  # noqa: E402
import k8s_staging as ks  # noqa: E402
from k8s_secrets import AGE_KEY_FILE  # noqa: E402
from k8srender.tables import STACKS  # noqa: E402

StagingError = ks.StagingError
SHM_DIR = Path("/dev/shm/txnet-staging")
HOST_VAR, KEY_VAR = "STAGING_PROD_SSH", "STAGING_PROD_SSH_KEY"
# Where production keeps its bundles (B1) and its checkout's passphrase (B5).
PROD_BUNDLE_DIR = "/var/backups/txnet/bundles"
# Production's checkout, where every release is deployed from (R5).
PROD_CHECKOUT = "/root/site-txnet-big"
PROD_PASSPHRASE = f"{PROD_CHECKOUT}/{bp.PASSPHRASE_FILE}"
# B1: the cluster's bundles carry the main stack's project; dev's never restore here.
PROD_PROJECT = STACKS["main"].project
RENDERED_DIRS = ("k8s/base", "k8s/monitoring/base")
# What prod.k8s.sh's compose() reads to list and build images.
BUILD_ENV_FILES = (".env", ".env.prod")


@dataclass(frozen=True)
class Production:
    """How production's server is reached: read-only here, by ssh."""
    host: str
    key: str

    @classmethod
    def from_env(cls, env) -> "Production":
        missing = [v for v in (HOST_VAR, KEY_VAR) if not env.get(v)]
        if missing:
            raise StagingError(f"set {', '.join(missing)} (in .env.dev): production's server is reached by ssh")
        return cls(env[HOST_VAR], env[KEY_VAR])

    @property
    def address(self) -> str:
        """The server's own host, without ssh's user."""
        return self.host.rpartition("@")[2]

    def ssh(self, command: str) -> list[str]:
        return ["ssh", "-i", self.key, "-o", "BatchMode=yes", self.host, command]

    def read(self, command: str, to: Path) -> None:
        """command's output into `to` (0600), never through a pipe of ours that could log it."""
        with open(os.open(to, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), "w") as out:
            subprocess.run(self.ssh(command), stdout=out, check=True)


def newest_bundle(names) -> str:
    """Production's newest finished bundle among names."""
    # Exactly this project's name: another project may share its prefix (`txnet-monitor`).
    ours = bp.oldest_first(n for n in names if bp.bundle_time(n) and bp.bundle_name(PROD_PROJECT, bp.bundle_time(n)) == n)
    if not ours:
        raise StagingError(f"production has no bundle of {PROD_PROJECT} in {PROD_BUNDLE_DIR}")
    return ours[-1]


def fetch(prod: Production) -> tuple[Path, Path]:
    """The newest bundle, its sum checked, and the passphrase, in SHM_DIR."""
    listing = subprocess.run(prod.ssh(f"ls -1 {PROD_BUNDLE_DIR}"), check=True, text=True, capture_output=True).stdout
    name = newest_bundle(listing.split())
    bundle, passphrase = SHM_DIR / name, SHM_DIR / "passphrase"
    for remote, local in ((f"{PROD_BUNDLE_DIR}/{name}", bundle), (f"{PROD_BUNDLE_DIR}/{name}.sha256", Path(f"{bundle}.sha256")),
                          (PROD_PASSPHRASE, passphrase)):
        prod.read(f"cat {remote}", local)
    subprocess.run(["sha256sum", "--quiet", "-c", f"{name}.sha256"], cwd=SHM_DIR, check=True)
    print(f"fetched {name}")
    return bundle, passphrase


def link_age_key(key: Path, place: Path) -> None:
    """The place sops and the restore read the node's key (K5, B5), pointed at the
    copy in memory. A real key there is this host's own: never replaced."""
    if place.is_symlink():
        place.unlink()
    if place.exists():
        raise StagingError(f"{place} is already a key of this host's: staging will not replace it")
    place.parent.mkdir(parents=True, exist_ok=True)
    place.symlink_to(key)


def unlink_age_key(memory: Path, place: Path) -> None:
    """Removes the link `link_age_key` made, and nothing else."""
    if place.is_symlink() and Path(os.readlink(place)).is_relative_to(memory):
        place.unlink()


def extract_age_key(bundle: Path, passphrase: Path) -> Path:
    """The age key out of the bundle's keys.tar (B5), into SHM_DIR."""
    work, _ = br.open_bundle(str(bundle), str(passphrase))
    try:
        member = AGE_KEY_FILE.lstrip("/")
        subprocess.run(["tar", "-C", str(SHM_DIR), "-xpf", os.path.join(work, "keys.tar"), member], check=True)
    finally:
        shutil.rmtree(work, ignore_errors=True)
    return SHM_DIR / member


def bundle_commit(bundle: Path, passphrase: Path) -> str:
    work, manifest = br.open_bundle(str(bundle), str(passphrase))
    shutil.rmtree(work, ignore_errors=True)
    return manifest["commit"]


def rendered_images(dirs) -> list[str]:
    """Every image the rendered manifests name, once, sorted."""
    found = set()
    for d in dirs:
        for path in Path(d).rglob("*.yaml"):
            found.update(line.split("image:", 1)[1].strip() for line in path.read_text().splitlines()
                         if line.strip().startswith("image:"))
    return sorted(found)


def restore_command(tree: Path, bundle: Path, passphrase: Path, memory: Path, prod_host: str,
                    newer_code: bool = False) -> tuple[list[str], dict]:
    """B10's restore into staging. --replace: the deploy seeded it, so it "holds data";
    the safety bundle that makes first stays in memory with the rest. `newer_code`:
    the tree is a later commit than the bundle's, which B9 allows only when asked.
    This checkout's restore, into the tree: its --scrub runs before any service
    starts (ADR-0168), and production's commit may predate it."""
    scrub = shlex.join(["python3", f"{ROOT}/tools/k8s_staging_scrub.py", "scrub", "--prod-host", prod_host])
    argv = ["python3", f"{ROOT}/scripts/bundle/backup.py", "restore", str(bundle),
            "--stack", "k8s", "--passphrase-file", str(passphrase), "--replace",
            "--checkout", str(tree), "--scrub", scrub]
    return argv + (["--allow-newer-code"] if newer_code else []), {"BACKUP_BUNDLE_DIR": str(memory / "safety")}


def staging_env(docker) -> dict:
    """What every command aimed at staging runs with: its kubectl, its address for
    compose's host-gateway (K3) and the smoke check, and no proxy between."""
    return {**os.environ, "KUBECTL": str(ks.KUBECTL_WRAPPER), "HOST_GATEWAY": ks.container_address(docker),
            "NO_PROXY": "*", "no_proxy": "*"}


def worktree(commit: str, name: str = "tree") -> Path:
    """A worktree at commit in SHM_DIR: its rendered manifests and env files hold secrets."""
    tree = SHM_DIR / name
    if not tree.exists():
        subprocess.run(["git", "-C", str(ROOT), "worktree", "add", "--quiet", "--detach", str(tree), commit], check=True)
    else:
        # One left by an earlier run may sit at another commit (2026-10-29: 7e49eb78
        # deployed under a 4b8a0cfa bundle); --force: its rendered files are not ours.
        subprocess.run(["git", "-C", str(tree), "checkout", "--quiet", "--force", "--detach", commit], check=True)
    return tree


def bring_images(docker, tree: Path, env: dict) -> None:
    """The images the release names, from this host's Docker, into staging (K14):
    what the registry lacks is built here first (R4), what is still missing pulled
    once. The build reaches the registry as this host does, through its proxy."""
    # The build host's env files (its mirror, its proxy), as a build in the checkout
    # reads them; gone before the restore, which writes production's own (B9).
    links = [tree / name for name in BUILD_ENV_FILES if not (tree / name).exists()]
    try:
        for link in links:
            link.symlink_to(ROOT / link.name)
        subprocess.run([f"{tree}/scripts/prod.k8s.sh", "build"], check=True)
    finally:
        for link in links:
            link.unlink(missing_ok=True)
    subprocess.run([f"{tree}/scripts/prod.k8s.sh", "render"], env=env, check=True)
    images = rendered_images(tree / d for d in RENDERED_DIRS)
    for image in images:
        if docker(["docker", "image", "inspect", image], check=False).returncode != 0:
            docker(["docker", "pull", "-q", image])
    ks.import_images(docker, images)


def restore_production(docker, prod: Production, at: str | None = None) -> None:
    """Production's data into staging, deployed at the bundle's commit, or at `at`
    (a later commit) when production's own cannot start there."""
    if docker(["docker", "inspect", ks.CONTAINER], check=False).returncode != 0:
        raise StagingError("staging is not up: `up` first")
    SHM_DIR.mkdir(mode=0o700, exist_ok=True)
    try:
        bring_production(docker, prod, at)
    except (StagingError, subprocess.CalledProcessError):
        # Production's secrets leave this host at once; the cluster stays for its
        # logs until `down`.
        forget(docker)
        raise
    print("production's data is in staging")


def bring_production(docker, prod: Production, at: str | None) -> None:
    bundle, passphrase = fetch(prod)
    link_age_key(extract_age_key(bundle, passphrase), Path(AGE_KEY_FILE))
    commit = bundle_commit(bundle, passphrase)
    if at:
        commit = subprocess.run(["git", "-C", str(ROOT), "rev-parse", f"{at}^{{commit}}"],
                                check=True, text=True, capture_output=True).stdout.strip()
    tree = worktree(commit)
    env = staging_env(docker)
    bring_images(docker, tree, env)
    subprocess.run([f"{tree}/scripts/prod.k8s.sh", "deploy"], env=env, check=True)
    argv, extra = restore_command(tree, bundle, passphrase, SHM_DIR, prod.address, newer_code=bool(at))
    subprocess.run(argv, env={**env, **extra}, check=True)


def forget(docker) -> None:
    """Everything of production's on this host, gone: the worktree, the memory
    directory, the age key's link. Safe when there is none."""
    for tree in SHM_DIR.glob("tree*"):
        docker(["git", "-C", str(ROOT), "worktree", "remove", "--force", str(tree)], check=False)
    unlink_age_key(SHM_DIR, Path(AGE_KEY_FILE))
    shutil.rmtree(SHM_DIR, ignore_errors=True)
    docker(["git", "-C", str(ROOT), "worktree", "prune"], check=False)
