#!/usr/bin/env python3
"""The whole platform as one encrypted file, and back (OPS-1-ad, hosting contract.bundle.md).

  now                       make a bundle at once (the nightly timer runs the same)
  list                      the bundles on this server, and which reached S3
  inspect FILE              what a bundle holds: date, commit, counts
  verify FILE               restore it into throwaway containers and compare; touches nothing
  restore FILE [--replace]  bring it up on this server; --replace when this server has data
  install-timers            the nightly bundle (03:00 UTC) and the ship every 10 minutes, as systemd timers

--stack names the compose wrapper this server runs, or `k8s` for the cluster
in namespace txnet (KUBECTL, default `kubectl`; OPS-1-o-k): a compose
server's bundle restores into a cluster, and the reverse.

Run as root from the repo. A bundle opens with dev-docker/secrets/backup-bundle-passphrase,
or --passphrase-file on a server that does not have it yet. Sending to S3 is
ship.py's. Runbook: docs/operations/runbook-backup-bundle.md
"""
import argparse
import getpass
import glob
import os
import shlex
import shutil
import sys
import tempfile
import time

sys.path.insert(0, os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "move"))
import bundle_io as bio  # noqa: E402
import bundle_make as bm  # noqa: E402
import bundle_plan as bp  # noqa: E402
import bundle_restore as br  # noqa: E402
import bundle_stack as bs  # noqa: E402
import bundle_timers as bt  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def say(message, *args):
    print("backup: " + (message % args if args else message), flush=True)


def make_now(host):
    with bio.locked(bio.BUNDLE_DIR, "bundle"):
        started = time.monotonic()
        path, manifest = bm.make(host, ROOT, bm.now())
        figures = manifest["figures"]
        say("%s (%d MB, %ds)", path, os.path.getsize(path) >> 20, time.monotonic() - started)
        say("%d tables, %d+%d Redis keys, %d queued messages, %d file volumes, %d keys and env files",
            len([k for k in figures if k.startswith("pg:")]), figures["redis:persistent"],
            figures["redis:volatile"], figures["mq:messages"], len(manifest["volumes"]), len(manifest["keys"]))
        config = host.config()
        bio.write_metrics(bio.textfile_dir(config), "backup_bundle", {
            "txnet_backup_bundle_last_success_timestamp_seconds": int(time.time()),
            "txnet_backup_bundle_last_bytes": os.path.getsize(path)})
        left = bm.upkeep(ROOT, config)
        say("%d bundle(s) not yet in S3", len(left))


def list_bundles():
    shipped = bp.parse_ledger(bio.read_ledger(bio.BUNDLE_DIR))
    names = bp.oldest_first(os.listdir(bio.BUNDLE_DIR) if os.path.isdir(bio.BUNDLE_DIR) else [])
    for name in names:
        size = os.path.getsize(os.path.join(bio.BUNDLE_DIR, name)) >> 20
        print("%-62s %6d MB  %s" % (name, size, "in S3" if name in shipped else "not shipped"))
    if not names:
        say("no bundles in %s", bio.BUNDLE_DIR)


def passphrase_file(args, scratch):
    """The given file, this repo's, or one typed in (kept in the private scratch directory)."""
    if args.passphrase_file:
        return args.passphrase_file
    own = os.path.join(ROOT, bp.PASSPHRASE_FILE)
    if os.path.exists(own):
        return own
    typed = os.path.join(scratch, "passphrase")
    with open(os.open(typed, os.O_CREAT | os.O_WRONLY, 0o600), "w") as f:
        f.write(getpass.getpass("bundle passphrase: ") + "\n")
    return typed


def open_and(args, host, action):
    scratch = tempfile.mkdtemp(prefix="txnet-bundle-")
    work = None
    try:
        passphrase = passphrase_file(args, scratch)
        work, manifest = br.open_bundle(os.path.abspath(args.file), passphrase)
        say("%s: made %s on %s (%s), commit %s", os.path.basename(args.file), manifest["created"],
            manifest["host"], manifest["project"], manifest["commit"][:12])
        action(work, manifest, passphrase)
    finally:
        for path in (work, scratch):
            if path:
                shutil.rmtree(path, ignore_errors=True)


def main(argv=None):
    stacks = sorted(os.path.basename(p)[: -len(".compose.sh")] for p in glob.glob(os.path.join(ROOT, "scripts", "*.compose.sh")))
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("command", choices=["now", "list", "inspect", "verify", "restore", "install-timers"])
    parser.add_argument("file", nargs="?", help="the bundle, for inspect / verify / restore")
    parser.add_argument("--stack", choices=stacks + [bs.K8S], default="dev",
                        help="the compose wrapper this server runs, or k8s")
    parser.add_argument("--passphrase-file", help="the bundle's passphrase, when this server does not hold it yet")
    parser.add_argument("--replace", action="store_true", help="restore over this server's data (a safety bundle first)")
    parser.add_argument("--allow-newer-code", action="store_true", help="restore into a checkout newer than the bundle")
    parser.add_argument("--checkout", default=ROOT, help="restore: the checkout the stack runs from, when not this one")
    parser.add_argument("--scrub", help="restore: a command run after the stores and before any service starts; "
                        "its failure leaves every service stopped")
    args = parser.parse_args(argv)
    if args.command in ("inspect", "verify", "restore") and not args.file:
        parser.error("%s needs the bundle file" % args.command)
    host = bs.open_stack(args.checkout, args.stack)
    options = br.Options(replace_here=args.replace, allow_newer_code=args.allow_newer_code,
                         scrub=shlex.split(args.scrub or ""))
    actions = {
        "now": lambda: make_now(host),
        "list": list_bundles,
        "install-timers": lambda: say("enabled: %s", ", ".join(bt.install(ROOT, args.stack))),
        "inspect": lambda: open_and(args, host, lambda work, manifest, _: print_manifest(manifest)),
        "verify": lambda: open_and(args, host, lambda work, manifest, _: [say(line) for line in br.drill(host, work, manifest)]),
        "restore": lambda: open_and(args, host, lambda work, manifest, pf: br.restore(host, args.checkout, work, manifest, pf, options, say)),
    }
    try:
        actions[args.command]()
    except (br.Abort, RuntimeError) as err:
        say("STOPPED: %s", err)
        return 1
    finally:
        host.close()
    return 0


def print_manifest(manifest):
    figures = manifest["figures"]
    say("databases %s; %d tables; users %s", ", ".join(manifest["postgres"]["databases"]),
        len([k for k in figures if k.startswith("pg:")]), figures.get("pg:identity.user", "?"))
    say("Redis %d keys without a TTL, %d with; %d queued messages", figures["redis:persistent"],
        figures["redis:volatile"], figures["mq:messages"])
    say("file volumes: %s", ", ".join(manifest["volumes"]))
    say("keys and env: %s", ", ".join(sorted(manifest["keys"])))


if __name__ == "__main__":
    sys.exit(main())
