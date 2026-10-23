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

import bundle_io as bio
import bundle_make as bm
import bundle_plan as bp
import mq_messages as mq
import move_figures as mf
import move_plan as mp

UNSEAL = 'gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$2" -d "$1" | zstd -dq | tar -C "$3" -xf -'
READY_TRIES = 60
WAIT_TIMEOUT_S = "600"
DRILL_CONTAINER = "txnet-bundle-drill"
PSQL = 'psql -U "$POSTGRES_USER" -d "$1" -Atq'
PG_RESTORE = 'pg_restore -U "$POSTGRES_USER" --create --exit-on-error -d postgres'
DROP_DATABASE = 'psql -U "$POSTGRES_USER" -d postgres -q -c "DROP DATABASE IF EXISTS \\"$1\\" WITH (FORCE)"'
# Each statement on its own: a role this server already has fails its CREATE
# and still takes the bundle's ALTER (password, attributes).
ROLES = 'psql -U "$POSTGRES_USER" -d postgres -q -v ON_ERROR_STOP=0'


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
    config = host.config()
    image = config["services"]["main-db"]["image"]
    su = manifest["postgres"]["superuser"]
    # the base image's entrypoint: ours (H1) wants the pgBackRest passphrase, which a drill has no use for
    host.run(["docker", "run", "-d", "--rm", "--network", "none", "--name", DRILL_CONTAINER, "-e", "POSTGRES_USER=" + su,
              "-e", "POSTGRES_HOST_AUTH_METHOD=trust", "-e", "POSTGRES_DB=postgres",
              "--entrypoint", "docker-entrypoint.sh", image, "postgres"])
    try:
        in_drill = ["docker", "exec", "-i", DRILL_CONTAINER, "sh", "-c"]
        # ready means after initdb's own temporary server has stopped, not while it answers
        host.sh('for i in $(seq %d); do docker logs "$1" 2>&1 | grep -q "init process complete" '
                '&& docker exec "$1" pg_isready -q -U "$2" 2>/dev/null && exit 0; sleep 1; done; '
                'docker logs --tail 5 "$1"; exit 1' % READY_TRIES, DRILL_CONTAINER, su)
        restore_databases(host, in_drill, work, manifest)
        run_psql = lambda db, sql: host.run(in_drill + [PSQL, "_", db], stdin=sql)  # noqa: E731
        tables = gate(manifest, pg_counts(run_psql, manifest["postgres"]["main"]), ("pg:",), "row counts")
    finally:
        subprocess.run(["docker", "rm", "-f", DRILL_CONTAINER], capture_output=True)
    keyspace = bm.load_redis(host, config, os.path.join(work, "redis"))
    keys = gate(manifest, mf.parse_keyspace(keyspace), ("redis:",), "Redis keys")
    archives = [os.path.join(work, "volumes", v + ".tar") for v in manifest["volumes"]] + [os.path.join(work, "keys.tar")]
    for archive in archives:
        host.run(["tar", "-tf", archive])
    return ["%d tables match" % tables, "%d Redis figures match" % keys,
            "%d file volumes and the keys read back" % len(manifest["volumes"])]


def restore_databases(host, in_container, work, manifest):
    """roles, then each database dropped and restored from its dump, through in_container (`sh -c` argv)."""
    host.run_from_file(in_container + [ROLES], os.path.join(work, "postgres", "roles.sql"))
    for database in manifest["postgres"]["databases"]:
        host.run(in_container + [DROP_DATABASE, "_", database])
        host.run_from_file(in_container + [PG_RESTORE], os.path.join(work, "postgres", database + ".dump"))
    host.run(in_container + ['vacuumdb -U "$POSTGRES_USER" --all --analyze-only -q'])


def git_relation(host, root, commit):
    head = host.run(["git", "-C", root, "rev-parse", "HEAD"]).strip()

    def is_ancestor(older, newer):
        return subprocess.run(["git", "-C", root, "merge-base", "--is-ancestor", older, newer],
                              capture_output=True).returncode == 0
    return bp.code_relation(commit, head, is_ancestor)


def restore_keys(root, work, manifest, passphrase):
    """Writes the keys and env files this checkout lacks; returns (written, kept because different)."""
    here = {p: bio.path_digest(os.path.join(root, p)) for p in manifest["keys"]}
    write, differ = bp.keys_to_restore(manifest["keys"], here)
    if write:
        subprocess.run(["tar", "-C", root, "-xpf", os.path.join(work, "keys.tar"), *write], check=True)
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
    written, differ = restore_keys(root, work, manifest, passphrase)
    say("keys and env restored: %s", ", ".join(written) or "none missing")
    for path in differ:
        say("KEPT this server's %s: it differs from the bundle's (keys.tar in the bundle has the old one)", path)
    config = host.config()
    volumes = mp.state_volumes(config)
    had_data = has_data(host, volumes["postgres_data"])
    if had_data:
        if not options.replace_here:
            raise Abort("this server holds data; --replace replaces it (a safety bundle of it is made first)")
        say("this server holds data: a safety bundle of it first")
        say("safety bundle: %s", bm.make(host, root, bm.now())[0])
    say("stopping the stack; the platform is down from here")
    host.compose("up", "--no-start")
    host.compose("stop")
    restore_volumes(host, work, manifest, volumes)
    keyspace = bm.load_redis(host, config, os.path.join(work, "redis"), volume=volumes["redis_vol_internal"])
    say("Redis: %d figures match", gate(manifest, mf.parse_keyspace(keyspace), ("redis:",), "Redis keys"))
    host.compose("up", "-d", "--wait", "--wait-timeout", WAIT_TIMEOUT_S, "main-db")
    in_main = [host.wrapper(), "exec", "-T", "main-db", "sh", "-c"]
    restore_databases(host, in_main, work, manifest)
    # the bundle's roles carry the bundle's passwords; the services log in with this server's env
    host.run(["env", "ENV_FILE=.env." + host.stack, os.path.join(root, "scripts", "db-login-roles.sh")])
    run_psql = lambda db, sql: host.run(in_main + [PSQL, "_", db], stdin=sql)  # noqa: E731
    say("Postgres: %d tables match", gate(manifest, pg_counts(run_psql, manifest["postgres"]["main"]), ("pg:",), "row counts"))
    start(host, work, relation, say)
    if had_data and "pg-backup" in config["services"]:
        # a new server's pg-backup makes its own first full on its first start (H3); a second would hit its lock
        host.compose("exec", "-d", "pg-backup", "sh", "/usr/local/bin/pg-backup.sh", "full")
        say("a full pgBackRest backup has started: the baseline after this restore")


def has_data(host, volume):
    return os.path.exists(os.path.join(host.volume_dir(volume), "PG_VERSION"))


def restore_volumes(host, work, manifest, volumes):
    """Each file volume emptied and unpacked; RabbitMQ's emptied (its messages come back by publish)."""
    for key in manifest["volumes"]:
        target = host.volume_dir(volumes[key])
        host.run(["find", target, "-mindepth", "1", "-delete"])
        host.run(["tar", "-C", target, "--numeric-owner", "-xpf", os.path.join(work, "volumes", key + ".tar")])
    host.run(["find", host.volume_dir(volumes["rabbitmq_data"]), "-mindepth", "1", "-delete"])


def start(host, work, relation, say):
    """Everything up, and the queued messages published back."""
    if relation == bp.CODE_NEWER:
        say("the code is newer than the bundle: apply its migrations before the services read the schema "
            "(CLAUDE.md 'Dev database migrations'), then continue")
    try:
        host.compose("up", "-d", "--wait", "--wait-timeout", WAIT_TIMEOUT_S)
    except RuntimeError as err:
        say("WARNING: not every service became healthy (%s); the data is restored, look at `ps`", err)
    with open(os.path.join(work, "rabbitmq", "messages.json")) as f:
        messages = json.load(f)
    lost = mq.load(mq.Broker(host), messages)
    say("RabbitMQ: %d of %d queued messages published back%s", len(messages) - len(lost), len(messages),
        "" if not lost else "; NOT routed: " + ", ".join(sorted(set(lost))))
