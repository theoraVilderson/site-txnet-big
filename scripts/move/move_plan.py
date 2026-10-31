"""What a server move carries, and how it is copied (OPS-1-ac, hosting H23).

Pure: reads compose's resolved config and the repo tree, runs nothing.
"""
import os
import subprocess

# Compose volumes that hold state no other copy has. A volume in neither set
# stops the move (PlanError): a new volume is a decision, never a silent skip.
STATE_VOLUMES = frozenset({
    "postgres_data",       # main-db (H1)
    "redis_vol_internal",  # sessions, bot sign-ins, locks — AOF on disk (H21)
    "rabbitmq_data",       # durable queues, one node name (data.yml RABBITMQ_NODENAME)
    "object_storage",      # uploaded files (F-018-m, ADR-0120)
    "locales_runtime",     # runtime-written text (ADR-0050)
    "prometheus_data",     # monitoring history (user 2026-10-23)
    "grafana_data",
    "loki_data",
})
REBUILT_VOLUMES = frozenset({
    "pg_socket",              # a socket directory, recreated at start
    "locale_cache",           # snapshots locale-service serves again (H17)
    "translator_llm_models",
})

# Losing any of these makes data on the new server unreadable: the vault's
# tenant credentials and every pgBackRest set (secrets/README.md).
REQUIRED_FILES = (
    "dev-docker/secrets/vault-kek",
    "dev-docker/secrets/pg-backup-passphrase",
)
# What encrypts the backup bundles (OPS-1-ad); not required for a move, carried when present.
BUNDLE_PASSPHRASE_FILE = "dev-docker/secrets/backup-bundle-passphrase"
# Where ship.py reads its write-only S3 key (OPS-1-ad).
SHIP_ENV_FILE = "dev-docker/secrets/backup-ship.env"
# The secrets directory: whatever git ignores in it moves (ignored_secrets).
SECRETS_DIR = "dev-docker/secrets"
# Git-ignored, so a checkout on the new server does not have them.
CARRIED_FILES = REQUIRED_FILES + (
    BUNDLE_PASSPHRASE_FILE,
    SHIP_ENV_FILE,
    ".env",
    ".env.dev",
    ".env.prod",
    "txnet-backend/.env",
    "dev-docker/secrets/origin-pull/",
    "dev-docker/secrets/origin-cert/",
    "dev-docker/traefik/origin-pull/ca.pem",
    "dev-docker/monitoring/.env.dev",
    "dev-docker/monitoring/.env.prod",
    "dev-docker/monitoring/config-dev/bale_token.txt",
)

# The compose services that hold the state; everything else stops first (H23).
DATA_SERVICES = ("main-db", "memory-data", "rabbitmq")
# Where a backup repository is mounted inside pg-backup / main-db.
BACKUP_REPO_MOUNT = "/repo"
# Written on the old server by a finished cutover; the compose wrappers refuse to start beside it.
MOVED_MARKER = ".moved-to"

_RSYNC_COPY = ["rsync", "--archive", "--hard-links", "--acls", "--xattrs", "--numeric-ids"]
_RSYNC_BASE = _RSYNC_COPY + ["--delete"]


class PlanError(Exception):
    """The move cannot be planned safely; the message names what to decide."""


def state_volumes(config):
    """Compose volume key -> docker volume name, for every volume that holds state."""
    declared = config.get("volumes") or {}
    unknown = sorted(set(declared) - STATE_VOLUMES - REBUILT_VOLUMES)
    if unknown:
        raise PlanError(
            "volume(s) %s are neither state nor rebuildable: add each to "
            "STATE_VOLUMES or REBUILT_VOLUMES in scripts/move/move_plan.py" % ", ".join(unknown)
        )
    return {key: spec.get("name", key) for key, spec in declared.items() if key in STATE_VOLUMES}


def backup_dirs(config):
    """Host directories bound at /repo — the posix pgBackRest and restic repositories."""
    sources = set()
    for service in (config.get("services") or {}).values():
        for volume in service.get("volumes") or []:
            if volume.get("type") == "bind" and volume.get("target") == BACKUP_REPO_MOUNT:
                sources.add(volume["source"])
    return sorted(sources)


def missing_required(root):
    """REQUIRED_FILES absent under root."""
    return [path for path in REQUIRED_FILES if not os.path.exists(os.path.join(root, path))]


def ignored_secrets(root):
    """Every file git ignores under SECRETS_DIR: a secret added later moves without a list
    to keep (platform-owner-password, arvan-s3.env and arvan/ were missed, 2026-10-31)."""
    listed = subprocess.run(["git", "-C", root, "ls-files", "--others", "--ignored", "--exclude-standard",
                             "--", SECRETS_DIR], check=True, capture_output=True, text=True).stdout
    return sorted(listed.split())


def present_carried(root):
    """CARRIED_FILES that exist under root, and every ignored secret, as rsync --files-from reads them."""
    carried = [path for path in CARRIED_FILES if os.path.exists(os.path.join(root, path))]
    return carried + [path for path in ignored_secrets(root) if not path.startswith(tuple(carried))]


def service_environment(config, service):
    """A service's resolved environment as a dict, whichever form compose printed it in."""
    environment = config["services"][service].get("environment") or {}
    if isinstance(environment, list):
        environment = dict(item.split("=", 1) for item in environment)
    return environment


def pulled_services(config):
    """Services whose image comes from a registry: neither built here nor built by another
    service (pg-backup runs main-db's txnet/postgres:18, which no registry holds)."""
    services = config["services"]
    built = {s.get("image") for s in services.values() if s.get("build")}
    return sorted(name for name, s in services.items() if not s.get("build") and s.get("image") not in built)


def node_trees(config, root):
    """(path under root, image, mount target) for each checkout tree a service runs on with
    the host's own node_modules, which git does not hold. Either the service binds the
    host's `<tree>/node_modules` (site-pwa), or it builds nothing and runs a stock image
    on the tree (dev's Nest services). One with a build of its own that covers or ignores
    node_modules (coinsite, locale-service) runs on what its image holds, and is skipped."""
    prefix = root.rstrip("/") + "/"
    trees = {}
    for service in config["services"].values():
        binds = {v["source"]: v["target"] for v in service.get("volumes") or []
                 if v.get("type") == "bind" and (v.get("source") or "").startswith(prefix)}
        for source, target in binds.items():
            host_modules = binds.get(source + "/node_modules") == target + "/node_modules"
            if host_modules or (not service.get("build") and service.get("image")):
                trees.setdefault(os.path.relpath(source, root), (service.get("image"), target))
    return sorted((tree, image, target) for tree, (image, target) in trees.items())


def install_script(package):
    """npm ci, then Prisma's client where the package names a schema (node_modules/.prisma)."""
    return "npm ci && npx prisma generate" if "prisma" in package else "npm ci"


def not_ready(rows, services):
    """The services of `compose ps --format json` rows not yet running healthy. No
    healthcheck (Health "") counts as ready once running; one not listed is not ready."""
    ready = {r["Service"] for r in rows if r.get("State") == "running" and r.get("Health") in ("", "healthy")}
    return [s for s in services if s not in ready]


def env_values(text):
    """KEY=VALUE lines of an env file; a trailing ` # comment` and quotes dropped."""
    values = {}
    for line in text.splitlines():
        key, sep, value = line.strip().partition("=")
        if sep and key and not key.startswith("#"):
            values[key] = value.split(" #", 1)[0].strip().strip("'\"")
    return values


def build_host_files(env, home):
    """What a release reads outside the checkout, so the dev host builds and twins
    on the new server too: the registry login `push` uses, the hosts ssh already
    trusts, and the key the twin reads production's bundle with (STAGING_PROD_SSH_KEY)."""
    files = [os.path.join(home, ".docker", "config.json"), os.path.join(home, ".ssh", "known_hosts")]
    key = env.get("STAGING_PROD_SSH_KEY")
    if key:
        files += [key, key + ".pub"]
    return sorted(files)


def rabbitmq_node(config):
    """The node name compose gives rabbitmq; its queues live in a directory of that name."""
    return service_environment(config, "rabbitmq").get("RABBITMQ_NODENAME", "")


def quick_rsync(src, dest):
    """Compares size and mtime: the live presync, and a backup repository's
    final pass, whose files are written once and never rewritten in place."""
    return _RSYNC_BASE + [src, dest]


def checksum_rsync(src, dest):
    """A volume's final pass, after the clean stop. A file rewritten within the
    second of the presync keeps its size and mtime, and only content shows it."""
    return _RSYNC_BASE + ["--checksum", src, dest]


def files_rsync(src, dest):
    """CARRIED_FILES, read from stdin, at the same relative paths. No --delete:
    the new checkout has files of its own beside them."""
    return _RSYNC_COPY + ["--recursive", "--checksum", "--files-from=-", src, dest]
