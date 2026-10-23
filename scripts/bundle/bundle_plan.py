"""What a backup bundle holds, what it is called, and which ones are kept (OPS-1-ad).

Pure: names, retention, the ship ledger, and the checks a restore makes. The
state classification is the server move's (scripts/move/move_plan.py): one
answer to "what is state" for both.
"""
import datetime
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "move"))
import move_plan as mp  # noqa: E402

BUNDLE_PREFIX = "txnet-backup-"
BUNDLE_SUFFIX = ".tar.zst.gpg"
CHECKSUM_SUFFIX = ".sha256"
_TIME_FORMAT = "%Y-%m-%d_%H-%M-%SZ"
_TIME_WIDTH = len("2026-10-23_15-30-12Z")
# A week of nightly bundles on this disk; S3 keeps what its lifecycle rule says.
BUNDLES_KEPT = 7
# The repo-relative passphrase the bundle is encrypted with. Kept off the
# server too (a password manager): it is the one thing a restore needs besides the file.
PASSPHRASE_FILE = mp.BUNDLE_PASSPHRASE_FILE
SHIP_ENV_FILE = mp.SHIP_ENV_FILE
# Inside the bundle; the passphrase is not, since it is what opens it.
KEY_FILES = tuple(path for path in mp.CARRIED_FILES if path != PASSPHRASE_FILE)
# Volumes read through their own service, never copied as files: a file copy
# of a running Postgres or Redis is not consistent.
LOGICAL_VOLUMES = frozenset({"postgres_data", "redis_vol_internal", "rabbitmq_data"})

CODE_SAME, CODE_NEWER, CODE_OLDER, CODE_UNRELATED = "same", "newer", "older", "unrelated"


def bundle_name(project, when):
    """txnet-backup-<project>-<UTC date>_<time>Z.tar.zst.gpg"""
    return "%s%s-%s%s" % (BUNDLE_PREFIX, project, when.strftime(_TIME_FORMAT), BUNDLE_SUFFIX)


def bundle_time(name):
    """When name was made, or None when name is not a finished bundle."""
    if not (name.startswith(BUNDLE_PREFIX) and name.endswith(BUNDLE_SUFFIX)):
        return None
    # the stamp has dashes of its own, and so may a project name: it is the fixed-width tail
    stamp = name[: -len(BUNDLE_SUFFIX)][-_TIME_WIDTH:]
    try:
        return datetime.datetime.strptime(stamp, _TIME_FORMAT).replace(tzinfo=datetime.timezone.utc)
    except ValueError:
        return None


def oldest_first(names):
    """The finished bundles among names, oldest first."""
    return sorted((n for n in names if bundle_time(n)), key=bundle_time)


def to_prune(names, shipped, shipping_configured, kept=BUNDLES_KEPT):
    """Bundles beyond the newest `kept`; while shipping is on, never one not yet in S3."""
    old = oldest_first(names)[:-kept] if kept else oldest_first(names)
    return [n for n in old if n in shipped or not shipping_configured]


def ledger_line(name, sha256, when):
    """One line of the ship ledger: what reached S3, its checksum, and when."""
    return "%s %s %s" % (name, sha256, when.strftime("%Y-%m-%dT%H:%M:%SZ"))


def parse_ledger(text):
    """The bundle names the ship ledger says reached S3."""
    return {line.split()[0] for line in text.splitlines() if line.strip()}


def unshipped(names, shipped):
    """Bundles not yet in S3, oldest first: the order ship.py sends them."""
    return [n for n in oldest_first(names) if n not in shipped]


def file_volumes(config):
    """Compose volume key -> docker volume name, for the state volumes copied as files."""
    return {k: v for k, v in mp.state_volumes(config).items() if k not in LOGICAL_VOLUMES}


def verify_files(expected, actual):
    """Every file of the manifest missing or changed in the unpacked bundle."""
    problems = []
    for path, digest in sorted(expected.items()):
        if path not in actual:
            problems.append("%s: missing from the bundle" % path)
        elif actual[path] != digest:
            problems.append("%s: changed since the bundle was made" % path)
    return problems


def keys_to_restore(in_bundle, here):
    """(paths to write, paths kept because this server's copy differs).

    A key or env file this server lacks is restored; one it has with other
    content is kept and reported — replacing a live vault-kek would make every
    credential encrypted since the backup unreadable."""
    restore = sorted(p for p in in_bundle if here.get(p) is None)
    differ = sorted(p for p in in_bundle if here.get(p) not in (None, in_bundle[p]))
    return restore, differ


def code_relation(bundle_commit, head, is_ancestor):
    """How the checked-out code relates to the code the bundle was made with."""
    if bundle_commit == head:
        return CODE_SAME
    if is_ancestor(bundle_commit, head):
        return CODE_NEWER
    if is_ancestor(head, bundle_commit):
        return CODE_OLDER
    return CODE_UNRELATED


# ship.py's settings, in dev-docker/secrets/backup-ship.env.
SHIP_REQUIRED = ("BACKUP_S3_ENDPOINT", "BACKUP_S3_BUCKET", "BACKUP_S3_ACCESS_KEY_ID", "BACKUP_S3_SECRET_ACCESS_KEY")
# Passed to rclone as they are: a host that reaches S3 only through a proxy.
SHIP_PASSTHROUGH = ("HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY")
# rclone's provider when none is named: any S3-compatible store (Arvan, MinIO, …).
DEFAULT_S3_PROVIDER = "Other"


def parse_env(text):
    """KEY=VALUE lines of an env file: comments, blank and malformed lines skipped, quotes and ` # …` removed."""
    values = {}
    for line in text.splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        values[key.strip()] = value.split(" #")[0].strip().strip("'\"")
    return values


def missing_ship_settings(settings):
    return sorted(k for k in SHIP_REQUIRED if not settings.get(k))


def s3_destination(settings, name):
    """rclone's address of name in the bucket, under BACKUP_S3_PREFIX when set."""
    prefix = settings.get("BACKUP_S3_PREFIX", "").strip("/")
    return "s3:%s/%s%s" % (settings["BACKUP_S3_BUCKET"], prefix + "/" if prefix else "", name)


def rclone_env(settings):
    """The settings in rclone's own names, for one remote called `s3`."""
    env = {
        "RCLONE_CONFIG_S3_TYPE": "s3",
        "RCLONE_CONFIG_S3_PROVIDER": settings.get("BACKUP_S3_PROVIDER") or DEFAULT_S3_PROVIDER,
        "RCLONE_CONFIG_S3_ENDPOINT": settings["BACKUP_S3_ENDPOINT"],
        "RCLONE_CONFIG_S3_ACCESS_KEY_ID": settings["BACKUP_S3_ACCESS_KEY_ID"],
        "RCLONE_CONFIG_S3_SECRET_ACCESS_KEY": settings["BACKUP_S3_SECRET_ACCESS_KEY"],
        # a write-only key may not create the bucket, or even ask whether it exists
        "RCLONE_S3_NO_CHECK_BUCKET": "true",
    }
    if settings.get("BACKUP_S3_REGION"):
        env["RCLONE_CONFIG_S3_REGION"] = settings["BACKUP_S3_REGION"]
    env.update({k: settings[k] for k in SHIP_PASSTHROUGH if settings.get(k)})
    return env
