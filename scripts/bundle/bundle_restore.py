"""Opens a backup bundle, proves it, and brings it up here or on a new server (OPS-1-ad).

open_bundle  decrypt, unpack, check every file against the manifest
drill        restore into throwaway containers and compare, touching nothing
restore      replace this server's state with the bundle's (a safety bundle first)
"""
import dataclasses
import json
import os
import shutil
import subprocess
import tempfile
import time

import bundle_io as bio
import bundle_make as bm
import bundle_plan as bp
import mq_messages as mq
import move_figures as mf
import move_plan as mp

UNSEAL = 'gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$2" -d "$1" | zstd -dq | tar -C "$3" -xf -'
READY_TRIES = 60
# The base image's entrypoint: ours (H1) wants the pgBackRest passphrase, which a
# drill has no use for. No address to listen on: trust, so the socket only.
DRILL_POSTGRES = ["docker-entrypoint.sh", "postgres", "-c", "listen_addresses="]
PSQL = 'psql -U "$POSTGRES_USER" -d "$1" -Atq'
PG_RESTORE = 'pg_restore -U "$POSTGRES_USER" --create --exit-on-error -d postgres "$1" && rm "$1"'
DROP_DATABASE = 'psql -U "$POSTGRES_USER" -d postgres -q -c "DROP DATABASE IF EXISTS \\"$1\\" WITH (FORCE)"'
# Each statement on its own: a role this server already has fails its CREATE
# and still takes the bundle's ALTER (password, attributes).
ROLES = 'psql -U "$POSTGRES_USER" -d postgres -q -v ON_ERROR_STOP=0 -f "$1" && rm "$1"'
# Where a dump is put before it runs: whole and counted (bundle_stack.Box.put).
RESTORE_DIR = "/tmp/txnet-restore"


class Abort(Exception):
    """Stops the restore; the message says what state this server is in."""


@dataclasses.dataclass
class Options:
    replace_here: bool = False      # this server has data and may lose it (a safety bundle is made first)
    allow_newer_code: bool = False  # the checkout is newer than the bundle: migrations run after


def open_bundle(path, passphrase):
    """Unpacks path into a private work directory; returns (work, manifest). The caller removes work."""
    sidecar = path + bp.CHECKSUM_SUFFIX
    if os.path.exists(sidecar) and open(sidecar).read().split()[0] != bio.sha256_file(path):
        raise Abort("%s does not match %s: the download is damaged" % (path, sidecar))
    work = tempfile.mkdtemp(prefix=".open-", dir=os.path.dirname(os.path.abspath(path)))
    try:
        try:
            bio.pipeline(UNSEAL, path, passphrase, work)
        except RuntimeError as err:
            if "decryption failed" in str(err):
                raise Abort("the passphrase does not open %s (or it is not a bundle)" % os.path.basename(path))
            raise
        with open(os.path.join(work, "manifest.json")) as f:
            manifest = json.load(f)
        if manifest.get("format") != bm.FORMAT:
            raise Abort("bundle format %s, this tool reads %s" % (manifest.get("format"), bm.FORMAT))
        actual = {k: v for k, v in bio.tree_digests(work).items() if k != "manifest.json"}
        problems = bp.verify_files(manifest["files"], actual)
        if problems:
            raise Abort("; ".join(problems))
        return work, manifest
    except Exception:
        shutil.rmtree(work, ignore_errors=True)
        raise


def pg_counts(run_psql, database):
    return mf.parse_counts(run_psql(database, mf.TABLE_COUNTS_SQL + ";"))


def gate(manifest, found, prefixes, what):
    expected = {k: v for k, v in manifest["figures"].items() if k.startswith(prefixes)}
    problems = mf.compare(expected, found, mf.RESTORE_RULES)
    if problems:
        raise Abort("%s differ from the bundle: %s" % (what, "; ".join(problems)))
    return len(expected)


def drill(host, work, manifest):
    """Restores the bundle into throwaway containers and compares; returns lines to print."""
    su = manifest["postgres"]["superuser"]
    env = {"POSTGRES_USER": su, "POSTGRES_HOST_AUTH_METHOD": "trust", "POSTGRES_DB": "postgres"}
    with host.scratch(host.image("main-db"), command=DRILL_POSTGRES, env=env) as box:
        wait_ready(host, box, su)
        in_drill = box.exec_argv("sh", "-c")
        restore_databases(host, box, work, manifest)
        run_psql = lambda db, sql: host.run(in_drill + [PSQL, "_", db], stdin=sql)  # noqa: E731
        tables = gate(manifest, pg_counts(run_psql, manifest["postgres"]["main"]), ("pg:",), "row counts")
    keyspace = bm.load_redis(host, os.path.join(work, "redis"))
    keys = gate(manifest, mf.parse_keyspace(keyspace), ("redis:",), "Redis keys")
    archives = [os.path.join(work, "volumes", v + ".tar") for v in manifest["volumes"]] + [os.path.join(work, "keys.tar")]
    for archive in archives:
        host.run(["tar", "-tf", archive])
    return ["%d tables match" % tables, "%d Redis figures match" % keys,
            "%d file volumes and the keys read back" % len(manifest["volumes"])]


def wait_ready(host, box, superuser):
    """Ready means after initdb's own temporary server has stopped, not while it answers."""
    for _ in range(READY_TRIES):
        if "init process complete" in box.logs():
            try:
                host.run(box.exec_argv("pg_isready", "-q", "-U", superuser))
                return
            except RuntimeError:
                pass  # the final server is still starting
        time.sleep(1)
    raise Abort("the drill's Postgres did not start: %s" % box.logs()[-500:])


def restore_databases(host, box, work, manifest):
    """roles, then each database dropped and restored from its dump, each file put into box first."""
    def run_file(script, name, *args):
        inside = "%s/%s" % (RESTORE_DIR, name)
        box.put(os.path.join(work, "postgres", name), inside)
        host.run(box.exec_argv("sh", "-c", script, "_", inside, *args))
    run_file(ROLES, "roles.sql")
    for database in manifest["postgres"]["databases"]:
        host.run(box.exec_argv("sh", "-c", DROP_DATABASE, "_", database))
        run_file(PG_RESTORE, database + ".dump")
    host.run(box.exec_argv("sh", "-c", 'vacuumdb -U "$POSTGRES_USER" --all --analyze-only -q'))


def git_relation(host, root, commit):
    head = host.run(["git", "-C", root, "rev-parse", "HEAD"]).strip()

    def is_ancestor(older, newer):
        return subprocess.run(["git", "-C", root, "merge-base", "--is-ancestor", older, newer],
                              capture_output=True).returncode == 0
    return bp.code_relation(commit, head, is_ancestor)


def restore_keys(host, root, work, manifest, passphrase):
    """Writes the keys and env files this server lacks; returns (written, kept because different).
    What this server has is the stack's answer: on a node with sealed secrets, the sealed copy (S4)."""
    here = {p: host.key_digest(p) for p in manifest["keys"]}
    write, differ = bp.keys_to_restore(manifest["keys"], here)
    # Two extractions: a checkout path lands under root, the age key at its own
    # absolute place (bp.key_tar_args stored it from /).
    for base, members in ((root, [p for p in write if not os.path.isabs(p)]),
                          ("/", [p.lstrip("/") for p in write if os.path.isabs(p)])):
        if members:
            subprocess.run(["tar", "-C", base, "-xpf", os.path.join(work, "keys.tar"), *members], check=True)
    target = os.path.join(root, bp.PASSPHRASE_FILE)
    if not os.path.exists(target):
        shutil.copyfile(passphrase, target)  # so the nightly bundle runs here too
        os.chmod(target, 0o600)
    return write, differ


def restore(host, root, work, manifest, passphrase, options, say):
    """Replaces this server's state with the bundle's, then starts the stack."""
    relation = git_relation(host, root, manifest["commit"])
    if relation in (bp.CODE_OLDER, bp.CODE_UNRELATED) or (relation == bp.CODE_NEWER and not options.allow_newer_code):
        raise Abort("the bundle was made at commit %s and this checkout is %s of it: "
                    "`git checkout %s` first (or --allow-newer-code when newer)" % (manifest["commit"], relation, manifest["commit"]))
    written, differ = restore_keys(host, root, work, manifest, passphrase)
    say("keys and env restored: %s", ", ".join(written) or "none missing")
    for path in differ:
        say("KEPT this server's %s: it differs from the bundle's (keys.tar in the bundle has the old one)", path)
    # after the keys: a new server's env files are the bundle's, written just now
    mismatch = bp.main_database_mismatch(manifest, host.config())
    if mismatch:
        raise Abort(mismatch + "; nothing was stopped")
    had_data = host.holds_data()
    if had_data:
        if not options.replace_here:
            raise Abort("this server holds data; --replace replaces it (a safety bundle of it is made first)")
        say("this server holds data: a safety bundle of it first")
        say("safety bundle: %s", bm.make(host, root, bm.now())[0])
    host.prepare(say)
    say("stopping the stack; the platform is down from here")
    host.stop_all()
    restore_stores(host, work, manifest, say)
    start(host, work, relation, say)
    if had_data and host.has_service("pg-backup"):
        # a new server's pg-backup makes its own first full on its first start (H3); a second would hit its lock
        host.start_full_backup()
        say("a full pgBackRest backup has started: the baseline after this restore")


def restore_stores(host, work, manifest, say):
    """The volumes and Redis written while everything is stopped, then the three stores up and filled."""
    for key in manifest["volumes"]:
        host.unpack_volume(key, os.path.join(work, "volumes", key + ".tar"))
    host.empty_volume("rabbitmq_data")  # its messages come back by publish
    keyspace = bm.load_redis(host, os.path.join(work, "redis"), volume="redis_vol_internal")
    say("Redis: %d figures match", gate(manifest, mf.parse_keyspace(keyspace), ("redis:",), "Redis keys"))
    # the stores first and alone: a broker booting beside eleven compiling services
    # timed out its first boot on the 2026-10-23 test, and every consumer that
    # found no broker exited (dev-serve then waits for a file change)
    host.start_data()
    definitions = os.path.join(work, "rabbitmq", "definitions.json")
    mq.restore_definitions(host, definitions if os.path.exists(definitions) else None)
    say("RabbitMQ: %s, and the env's user set from this server's env",
        "users, vhosts, permissions and queues imported" if os.path.exists(definitions) else "no definitions in this bundle")
    in_main = host.exec_argv("main-db", "sh", "-c")
    restore_databases(host, host.service_box("main-db"), work, manifest)
    # the bundle's roles carry the bundle's passwords; the services log in with this server's env
    host.login_roles()
    run_psql = lambda db, sql: host.run(in_main + [PSQL, "_", db], stdin=sql)  # noqa: E731
    say("Postgres: %d tables match", gate(manifest, pg_counts(run_psql, manifest["postgres"]["main"]), ("pg:",), "row counts"))


def start(host, work, relation, say):
    """Everything up, and the queued messages published back."""
    if relation == bp.CODE_NEWER:
        say("the code is newer than the bundle: %s before the services read the schema, then continue", host.MIGRATE_HINT)
    try:
        host.start_all()
    except RuntimeError as err:
        say("WARNING: not every service became healthy (%s); the data is restored, look at its pods or `ps`", err)
    with open(os.path.join(work, "rabbitmq", "messages.json")) as f:
        messages = json.load(f)
    try:
        with host.management_url(mq.MANAGEMENT_PORT) as url:
            lost = mq.load(mq.Broker(host, url), messages)
    except (OSError, RuntimeError) as err:  # urllib's HTTPError and URLError are OSErrors
        say("WARNING: the %d queued messages were not published back (%s); they are in the bundle's "
            "rabbitmq/messages.json", len(messages), err)
        return
    say("RabbitMQ: %d of %d queued messages published back%s", len(messages) - len(lost), len(messages),
        "" if not lost else "; NOT routed: " + ", ".join(sorted(set(lost))))
