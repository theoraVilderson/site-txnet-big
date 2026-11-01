#!/usr/bin/env python3
"""Sends every finished backup bundle not yet in S3, each locked as it lands (OPS-1-ad, NIN-1-i).

Separate from the bundle on purpose: making a backup never depends on S3
answering. Each object is sent in compliance mode for BACKUP_S3_LOCK_DAYS, so
whoever takes the server and its S3 key still cannot delete a bundle inside
that window (B7). After a bundle lands, the older ones beyond bp.s3_keep go
(OPS-1-ad-s): removal follows a newer arrival, so a dead server's last bundles
stay. The bucket's lifecycle rule is a long backstop only.

Run by txnet-backup-ship.timer every 10 minutes, or by hand:
    python3 scripts/bundle/ship.py [--stack dev|k8s]
mc runs in a throwaway container, or pod on Kubernetes (OPS-1-o-k), with
the bundle directory mounted read-only and its settings on stdin.
Settings: dev-docker/secrets/backup-ship.env (runbook-backup-bundle.md). Without
it nothing is sent and it says so; the alert still counts what waits.
"""
import argparse
import datetime
import json
import os
import shlex
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "move"))
import bundle_io as bio  # noqa: E402
import bundle_make as bm  # noqa: E402
import bundle_plan as bp  # noqa: E402
import bundle_stack as bs  # noqa: E402

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), "tools"))
from k8srender.tables import MIRRORS_ENV  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
# Pulled through ${DOCKER_REGISTRY}, like every image (verified on the mirror 2026-10-30).
# mc, not rclone: rclone cannot set an object's retention on upload (NIN-1-i).
MC_IMAGE = "minio/mc:RELEASE.2025-08-13T08-35-41Z"
# The settings arrive on stdin as quoted assignments, so the key is never in an
# argv, an env file on disk or a pod spec.
MC_WITH_SETTINGS = 'set -a; . /dev/stdin; set +a; exec mc "$@"'


def say(message, *args):
    print("ship: " + (message % args if args else message), flush=True)


def read_settings(relative):
    path = os.path.join(ROOT, relative)
    return bp.parse_env(open(path).read()) if os.path.exists(path) else None


def mc(host, box, settings, *args):
    """mc's stdout, with the settings on stdin."""
    assignments = "".join("%s=%s\n" % (k, shlex.quote(v)) for k, v in sorted(bp.mc_env(settings).items()))
    return host.run(box.exec_argv("sh", "-c", MC_WITH_SETTINGS, "_", *args), stdin=assignments)


def send(host, box, settings, name):
    """name, then its .sha256: a checksum in S3 means its bundle arrived whole."""
    for path in (name, name + bp.CHECKSUM_SUFFIX):
        try:
            mc(host, box, settings, *bp.copy_args(settings, path))
        except RuntimeError as err:
            raise RuntimeError("%s: %s" % (path, err))


def prune_s3(host, box, settings):
    """Removes what bp.s3_to_remove names under this server's prefix; returns how many keys."""
    listing = mc(host, box, settings, "ls", "--json", bp.s3_destination(settings, ""))
    keys = [json.loads(line)["key"] for line in listing.splitlines() if line.strip()]
    removed = bp.s3_to_remove(keys, datetime.datetime.now(datetime.timezone.utc), bp.lock_days(settings))
    for key in removed:
        mc(host, box, settings, "rm", "--quiet", bp.s3_destination(settings, key))
    return len(removed)


def registry(host, root=ROOT):
    """DOCKER_REGISTRY from the env files the stack runs with: a node holds them sealed, never as .env (NIN-1-i3),
    and the committed mirrors.env after them (ADR-0170)."""
    paths = (host.env_files() if host.stack == bs.K8S else [".env"]) + [MIRRORS_ENV]
    merged = {}
    for path in paths:  # a later file wins, as compose and the render read them
        full = os.path.join(root, path)
        if os.path.exists(full):
            merged.update(bp.parse_env(open(full).read()))
    return merged["DOCKER_REGISTRY"]


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
    registry_host = registry(host)
    shipped = bp.parse_ledger(bio.read_ledger(bio.BUNDLE_DIR))
    waiting = bp.unshipped(os.listdir(bio.BUNDLE_DIR), shipped)
    sent = 0
    if waiting:
        with host.scratch("%s/%s" % (registry_host, MC_IMAGE), host_dir=(bio.BUNDLE_DIR, bp.SHIP_MOUNT), network=True) as box:
            for name in waiting:
                started = time.monotonic()
                send(host, box, settings, name)
                digest = open(os.path.join(bio.BUNDLE_DIR, name + bp.CHECKSUM_SUFFIX)).read().split()[0]
                with open(os.path.join(bio.BUNDLE_DIR, bio.LEDGER), "a") as ledger:
                    ledger.write(bp.ledger_line(name, digest, datetime.datetime.now(datetime.timezone.utc)) + "\n")
                say("%s -> %s (%ds)", name, bp.s3_destination(settings, name), time.monotonic() - started)
                sent += 1
            say("S3: %d old key(s) removed", prune_s3(host, box, settings))
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
    except (RuntimeError, ValueError) as err:
        say("STOPPED: %s", err)
        return 1
    finally:
        host.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
