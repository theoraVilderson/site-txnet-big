"""What a server move carries, and how it is copied (OPS-1-ac, hosting H23).

Pure: reads compose's resolved config and the repo tree, runs nothing.
"""
import os

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
# tenant credentials, every pgBackRest set, every restic snapshot (secrets/README.md).
REQUIRED_FILES = (
    "dev-docker/secrets/vault-kek",
    "dev-docker/secrets/pg-backup-passphrase",
    "dev-docker/secrets/object-backup-password",
)
# What encrypts the backup bundles (OPS-1-ad); not required for a move, carried when present.
BUNDLE_PASSPHRASE_FILE = "dev-docker/secrets/backup-bundle-passphrase"
# Where ship.py reads its write-only S3 key (OPS-1-ad).
SHIP_ENV_FILE = "dev-docker/secrets/backup-ship.env"
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
# Where a backup repository is mounted inside pg-backup / object-backup / main-db.
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


def present_carried(root):
    """CARRIED_FILES that exist under root, in the form rsync --files-from reads."""
    return [path for path in CARRIED_FILES if os.path.exists(os.path.join(root, path))]


def service_environment(config, service):
    """A service's resolved environment as a dict, whichever form compose printed it in."""
    environment = config["services"][service].get("environment") or {}
    if isinstance(environment, list):
        environment = dict(item.split("=", 1) for item in environment)
    return environment


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
