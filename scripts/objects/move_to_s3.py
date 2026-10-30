#!/usr/bin/env python3
"""Moves the stored files from the object_storage volume to the bucket, each checked by its sha256 (F-018-m2-d).

  copy              every file on the volume not yet in OBJECT_STORAGE_S3_BUCKET; never overwrites or deletes there
  verify [--repair] every stored_object row's bytes in the bucket against its sha256; --repair copies a
                    mismatched key again, only from volume bytes that match the row

The order (contract "Moving to S3"): copy; set OBJECT_STORAGE_DRIVER=s3 and recreate the services; copy
again (what landed on the volume meanwhile); verify --repair. No row changes, and the volume is kept.

Run as root on the server, from the repo root:
    python3 scripts/objects/move_to_s3.py copy|verify [--repair] [--stack dev|k8s]
Both run inside `object-backup`, which mounts the volume read-only and holds mc and the bucket's
settings (F-018-m2-c); the rows come from `main-db`.
"""
import argparse
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, os.path.join(ROOT, "scripts", "bundle"))
sys.path.insert(0, os.path.join(ROOT, "scripts", "move"))
import bundle_stack as bs  # noqa: E402

SERVICE = "object-backup"
# Superuser, so storage.stored_object's RLS shows every tenant's rows (rule 9).
ROWS_SQL = "select key, sha256 from storage.stored_object order by key"
PSQL_ROWS = 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -AtF " " -c "%s"' % ROWS_SQL
_SHA256 = re.compile(r"^[0-9a-f]{64}$")

_ALIAS = ('export MC_CONFIG_DIR=/tmp/mc-move; '
          'mc alias set src "$OBJECT_STORAGE_S3_ENDPOINT" "$OBJECT_STORAGE_S3_ACCESS_KEY_ID" '
          '"$OBJECT_STORAGE_S3_SECRET_ACCESS_KEY" >/dev/null || exit 2; B="src/$OBJECT_STORAGE_S3_BUCKET"; ')
# Missing files only: after the switch the bucket is the truth, and a file a
# user replaced there must not be overwritten by the volume's older bytes.
COPY_SCRIPT = _ALIAS + "mc mirror --exclude '*.tmp' --quiet /data/objects \"$B\""
# One line per row read on stdin: OK, REPAIRED (copied again from bytes that
# match the row) or BAD.
VERIFY_SCRIPT = _ALIAS + r'''
while read -r key sha; do
  got=$(mc cat "$B/$key" 2>/dev/null | sha256sum); got=${got%% *}
  if [ "$got" != "$sha" ] && [ "$REPAIR" = 1 ]; then
    here=$(sha256sum "/data/objects/$key" 2>/dev/null); here=${here%% *}
    if [ "$here" = "$sha" ] && mc cp --quiet "/data/objects/$key" "$B/$key" >/dev/null; then echo "REPAIRED $key"; continue; fi
  fi
  if [ "$got" = "$sha" ]; then echo "OK $key"; else echo "BAD $key"; fi
done'''


def say(message, *args):
    print("move-to-s3: " + (message % args if args else message), flush=True)


def parse_rows(text):
    """psql's `key sha256` lines -> [(key, sha256)]; anything else stops the check."""
    rows = []
    for line in filter(None, (l.strip() for l in text.splitlines())):
        key, _, sha = line.partition(" ")
        if not key.startswith("tenants/") or not _SHA256.match(sha):
            raise ValueError("not a stored_object row: %r" % line)
        rows.append((key, sha))
    return rows


def rows_input(rows):
    """The check's stdin: one `key sha256` per line."""
    return "".join("%s %s\n" % row for row in rows)


def verdict(output, expected=None):
    """The check's lines counted; a row it never answered is bad, so a check that died is not a clean move."""
    counts = {"ok": 0, "repaired": 0, "bad": []}
    for line in output.splitlines():
        word, _, key = line.partition(" ")
        if word == "OK":
            counts["ok"] += 1
        elif word == "REPAIRED":
            counts["repaired"] += 1
        elif word == "BAD":
            counts["bad"].append(key)
    answered = counts["ok"] + counts["repaired"] + len(counts["bad"])
    if expected is not None and answered < expected:
        counts["bad"].append("(%d row(s) never checked)" % (expected - answered))
    return counts


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("step", choices=("copy", "verify"))
    parser.add_argument("--repair", action="store_true", help="verify: copy a mismatched key again from matching volume bytes")
    parser.add_argument("--stack", default="dev", help="the compose wrapper this server runs, or k8s")
    args = parser.parse_args(argv)
    host = bs.open_stack(ROOT, args.stack)
    try:
        if args.step == "copy":
            host.run(host.exec_argv(SERVICE, "sh", "-c", COPY_SCRIPT))
            say("copied what the bucket lacked")
            return 0
        rows = parse_rows(host.run(host.exec_argv("main-db", "sh", "-c", PSQL_ROWS)))
        script = ("REPAIR=1; " if args.repair else "REPAIR=0; ") + VERIFY_SCRIPT
        result = verdict(host.run(host.exec_argv(SERVICE, "sh", "-c", script), stdin=rows_input(rows)), expected=len(rows))
        say("%d row(s): %d match, %d repaired, %d bad", len(rows), result["ok"], result["repaired"], len(result["bad"]))
        for key in result["bad"]:
            say("BAD %s", key)
        return 1 if result["bad"] else 0
    except (RuntimeError, ValueError) as err:
        say("STOPPED: %s", err)
        return 1
    finally:
        host.close()


if __name__ == "__main__":
    sys.exit(main())
