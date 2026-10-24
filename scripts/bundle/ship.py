#!/usr/bin/env python3
"""Sends every finished backup bundle not yet in S3, with a write-only key (OPS-1-ad).

Separate from the bundle on purpose: making a backup never depends on S3
answering, and this holds the only S3 key on the server — one that can write
but not delete, so whoever takes the server cannot take the backups too.
Retention in S3 is the bucket's lifecycle rule, not this script's.

Run by txnet-backup-ship.timer every 10 minutes, or by hand:
    python3 scripts/bundle/ship.py [--stack dev|k8s]
rclone runs in a throwaway container, or pod on Kubernetes (OPS-1-o-k), with
the bundle directory mounted read-only and its settings on stdin.
Settings: dev-docker/secrets/backup-ship.env (runbook-backup-bundle.md). Without
it nothing is sent and it says so; the alert still counts what waits.
"""
import argparse
import datetime
import os
import shlex
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "move"))
import bundle_io as bio  # noqa: E402
import bundle_make as bm  # noqa: E402
import bundle_plan as bp  # noqa: E402
import bundle_stack as bs  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# Pulled through ${DOCKER_REGISTRY}, like every image (verified on the mirror 2026-10-23).
RCLONE_IMAGE = "rclone/rclone:1.71"
# --no-check-dest and --s3-no-head: a write-only key may not HEAD an object, before
# the upload or after it (MinIO rehearsal, 2026-10-23: the object landed, the HEAD
# after it was refused, and rclone reported the copy failed). The PUT's own ETag
# is still checked, and the .sha256 beside each bundle is checked after a download.
RCLONE_FLAGS = ["--no-check-dest", "--s3-no-head", "--retries", "3", "--low-level-retries", "10",
                "--s3-upload-concurrency", "2", "-q"]
# The settings arrive on stdin as quoted assignments, so the key is never in an
# argv, an env file on disk or a pod spec.
RCLONE_WITH_SETTINGS = 'set -a; . /dev/stdin; set +a; exec rclone "$@"'


def say(message, *args):
    print("ship: " + (message % args if args else message), flush=True)


def read_settings(relative):
    path = os.path.join(ROOT, relative)
    return bp.parse_env(open(path).read()) if os.path.exists(path) else None


def send(host, box, settings, name):
    """name, then its .sha256: a checksum in S3 means its bundle arrived whole."""
    assignments = "".join("%s=%s\n" % (k, shlex.quote(v)) for k, v in sorted(bp.rclone_env(settings).items()))
    for path in (name, name + bp.CHECKSUM_SUFFIX):
        try:
            host.run(box.exec_argv("sh", "-c", RCLONE_WITH_SETTINGS, "_", "copyto", "/bundles/" + path,
                                   bp.s3_destination(settings, path), *RCLONE_FLAGS), stdin=assignments)
        except RuntimeError as err:
            raise RuntimeError("%s: %s" % (path, err))


def ship(host):
    """Sends what waits, oldest first; records each in the ledger; returns how many."""
    config = host.config()
    settings = read_settings(bp.SHIP_ENV_FILE)
    if settings is None:
        left = bm.upkeep(ROOT, config)
        say("%s is not there: nothing sent; %d bundle(s) wait", bp.SHIP_ENV_FILE, len(left))
        return 0
    missing = bp.missing_ship_settings(settings)
    if missing:
        raise RuntimeError("%s lacks %s" % (bp.SHIP_ENV_FILE, ", ".join(missing)))
    registry = bp.parse_env(open(os.path.join(ROOT, ".env")).read())["DOCKER_REGISTRY"]
    shipped = bp.parse_ledger(bio.read_ledger(bio.BUNDLE_DIR))
    waiting = bp.unshipped(os.listdir(bio.BUNDLE_DIR), shipped)
    sent = 0
    if waiting:
        with host.scratch("%s/%s" % (registry, RCLONE_IMAGE), host_dir=(bio.BUNDLE_DIR, "/bundles"), network=True) as box:
            for name in waiting:
                started = time.monotonic()
                send(host, box, settings, name)
                digest = open(os.path.join(bio.BUNDLE_DIR, name + bp.CHECKSUM_SUFFIX)).read().split()[0]
                with open(os.path.join(bio.BUNDLE_DIR, bio.LEDGER), "a") as ledger:
                    ledger.write(bp.ledger_line(name, digest, datetime.datetime.now(datetime.timezone.utc)) + "\n")
                say("%s -> %s (%ds)", name, bp.s3_destination(settings, name), time.monotonic() - started)
                sent += 1
    bio.write_metrics(bio.textfile_dir(config), "backup_bundle_shipped",
                      {"txnet_backup_ship_last_success_timestamp_seconds": int(time.time())})
    bm.upkeep(ROOT, config)
    return sent


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--stack", default="dev", help="the compose wrapper this server runs, or k8s")
    args = parser.parse_args(argv)
    host = bs.open_stack(ROOT, args.stack)
    try:
        with bio.locked(bio.BUNDLE_DIR, "ship"):
            say("%d sent", ship(host))
    except RuntimeError as err:
        say("STOPPED: %s", err)
        return 1
    finally:
        host.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
