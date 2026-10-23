"""Makes one backup bundle of the running platform, without stopping it (OPS-1-ad).

Postgres in one exported snapshot (the row counts are read in the same one),
Redis as an RDB that is loaded once before it is kept, the queued messages,
the file volumes, the keys and env files: one tar, zstd, gpg AES256.
"""
import datetime
import json
import os
import shutil
import socket
import subprocess
import tempfile

import bundle_io as bio
import bundle_plan as bp
import mq_messages as mq
import move_figures as mf
import move_hosts as mh

FORMAT = 1
# Two threads: the host also serves the live site and the bot (keep two cores free).
ZSTD_THREADS = 2
ZSTD_LEVEL = 10
PG_DUMP_COMPRESSION = "zstd:3"
SESSION_TIMEOUT_S = 30
PSQL_SESSION = 'exec psql -U "$POSTGRES_USER" -d "$1" -Atq -v ON_ERROR_STOP=1'
PG_DUMP = 'pg_dump -U "$POSTGRES_USER" -d "$1" -Fc -Z "$2" ${3:+--snapshot="$3"}'
DATABASES_SQL = "select datname from pg_database where not datistemplate and datname <> 'postgres' order by 1"
REDIS_RDB = 'read -r pw; REDISCLI_AUTH="$pw" redis-cli --rdb - 2>/dev/null'
REDIS_LOAD_SCRIPT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "redis-load.sh")
SEAL = (
    'tar -C "$1" -cf - . | zstd -q -T%d -%d | gpg --batch --yes --pinentry-mode loopback '
    '--passphrase-file "$2" --symmetric --cipher-algo AES256 --compress-algo none -o "$3"' % (ZSTD_THREADS, ZSTD_LEVEL)
)
_END = "__txnet_bundle_end__"


def make(host, root, when):
    """Writes <BUNDLE_DIR>/<name> and its .sha256; returns (path, manifest)."""
    config = host.config()
    passphrase = bio.passphrase_path(root, bp.PASSPHRASE_FILE)
    name = bp.bundle_name(config["name"], when)
    os.makedirs(bio.BUNDLE_DIR, mode=0o700, exist_ok=True)
    staging = tempfile.mkdtemp(prefix=".staging-", dir=bio.BUNDLE_DIR)
    try:
        manifest = {"format": FORMAT, "created": when.strftime("%Y-%m-%dT%H:%M:%SZ"), "project": config["name"],
                    "stack": host.stack, "host": socket.gethostname(), "figures": {},
                    "commit": host.run(["git", "-C", root, "rev-parse", "HEAD"]).strip()}
        dump_postgres(host, staging, manifest)
        dump_redis(host, config, staging, manifest)
        messages = mq.save(mq.Broker(host))
        write_json(os.path.join(staging, "rabbitmq", "messages.json"), messages)
        manifest["figures"]["mq:messages"] = len(messages)
        manifest["volumes"] = pack_volumes(host, config, staging)
        manifest["keys"] = pack_keys(root, staging)
        manifest["files"] = bio.tree_digests(staging)
        write_json(os.path.join(staging, "manifest.json"), manifest)
        return seal(staging, name, passphrase), manifest
    finally:
        shutil.rmtree(staging, ignore_errors=True)


def write_json(path, value):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(value, f, indent=1, sort_keys=True)


def main_db(host, *args):
    """argv running args inside main-db, through the stack's wrapper."""
    return [host.wrapper(), "exec", "-T", "main-db", *args]


def dump_postgres(host, staging, manifest):
    """roles.sql, then <db>.dump for every database; the main one with its row counts."""
    folder = os.path.join(staging, "postgres")
    os.makedirs(folder)
    env = {k: host.compose("exec", "-T", "main-db", "printenv", k).strip() for k in ("POSTGRES_USER", "POSTGRES_DB")}
    host.run_to_file(main_db(host, "sh", "-c", 'pg_dumpall -U "$POSTGRES_USER" --roles-only'),
                     os.path.join(folder, "roles.sql"))
    databases = host.compose("exec", "-T", "main-db", "sh", "-c", PSQL_SESSION, "_", env["POSTGRES_DB"],
                             stdin=DATABASES_SQL + ";\n").split()
    for database in databases:
        path = os.path.join(folder, database + ".dump")
        if database == env["POSTGRES_DB"]:
            manifest["figures"].update(dump_in_snapshot(host, database, path))
        else:
            host.run_to_file(main_db(host, "sh", "-c", PG_DUMP, "_", database, PG_DUMP_COMPRESSION, ""), path)
    manifest["postgres"] = {"superuser": env["POSTGRES_USER"], "main": env["POSTGRES_DB"], "databases": databases}


def dump_in_snapshot(host, database, path):
    """pg_dump of database and its row counts, both from one exported snapshot."""
    session = subprocess.Popen(main_db(host, "sh", "-c", PSQL_SESSION, "_", database), stdin=subprocess.PIPE,
                               stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    try:
        snapshot = ask(session, "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SELECT pg_export_snapshot();")[0]
        counts = mf.parse_counts("\n".join(ask(session, mf.TABLE_COUNTS_SQL + ";")))
        host.run_to_file(main_db(host, "sh", "-c", PG_DUMP, "_", database, PG_DUMP_COMPRESSION, snapshot), path)
        ask(session, "COMMIT;")
    finally:
        session.stdin.close()
        session.wait(timeout=SESSION_TIMEOUT_S)
    return counts


def ask(session, sql):
    """Runs sql in the open psql session; its output lines."""
    session.stdin.write(sql + "\n\\echo " + _END + "\n")
    session.stdin.flush()
    lines = []
    for line in session.stdout:
        if line.rstrip("\n") == _END:
            return lines
        lines.append(line.rstrip("\n"))
    raise RuntimeError("psql ended early: %s" % session.stderr.read().strip())


def dump_redis(host, config, staging, manifest):
    """An RDB of the live keyspace, loaded once in a throwaway Redis: a bundle whose Redis does not load fails here."""
    folder = os.path.join(staging, "redis")
    os.makedirs(folder)
    host.run_to_file([host.wrapper(), "exec", "-T", "memory-data", "sh", "-c", REDIS_RDB],
                     os.path.join(folder, "dump.rdb"), stdin=(mh.redis_password(config) + "\n").encode())
    manifest["figures"].update(mf.parse_keyspace(load_redis(host, config, folder)))


def load_redis(host, config, rdb_folder, volume=None):
    """redis-load.sh in memory-data's image: into `volume`, or scratch storage when None."""
    mounts = ["-v", "%s:/bundle:ro" % rdb_folder, "-v", "%s:/load.sh:ro" % REDIS_LOAD_SCRIPT]
    if volume:
        mounts += ["-v", "%s:/data" % volume]
    image = config["services"]["memory-data"]["image"]
    return host.run(["docker", "run", "--rm", "--network", "none", *mounts, "--entrypoint", "sh", image, "/load.sh"])


def pack_volumes(host, config, staging):
    """volumes/<key>.tar for every state volume copied as files; returns the keys."""
    folder = os.path.join(staging, "volumes")
    os.makedirs(folder)
    volumes = bp.file_volumes(config)
    for key, name in sorted(volumes.items()):
        host.run(["tar", "-C", host.volume_dir(name), "--numeric-owner", "-cf", os.path.join(folder, key + ".tar"), "."])
    return sorted(volumes)


def pack_keys(root, staging):
    """keys.tar of the keys and env files present; returns {path: digest}."""
    present = [p for p in bp.KEY_FILES if os.path.exists(os.path.join(root, p))]
    subprocess.run(["tar", "-C", root, "-cf", os.path.join(staging, "keys.tar"), *present], check=True)
    return {p: bio.path_digest(os.path.join(root, p)) for p in present}


def seal(staging, name, passphrase):
    """tar | zstd | gpg into name, then its .sha256 beside it; the name appears last, whole."""
    final = os.path.join(bio.BUNDLE_DIR, name)
    partial = final + ".partial"
    try:
        # owner-only: encrypted, but its name and size are nobody else's business
        os.close(os.open(partial, os.O_CREAT | os.O_WRONLY, 0o600))
        bio.pipeline(SEAL, staging, passphrase, partial)
        with open(os.open(final + bp.CHECKSUM_SUFFIX, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600), "w") as f:
            f.write("%s  %s\n" % (bio.sha256_file(partial), name))
        os.replace(partial, final)
    finally:
        if os.path.exists(partial):
            os.remove(partial)
    return final


def upkeep(root, config):
    """Deletes bundles past the newest BUNDLES_KEPT (never an unshipped one while
    shipping is on) and reports what is left to ship."""
    names = os.listdir(bio.BUNDLE_DIR) if os.path.isdir(bio.BUNDLE_DIR) else []
    shipped = bp.parse_ledger(bio.read_ledger(bio.BUNDLE_DIR))
    configured = os.path.exists(os.path.join(root, bp.SHIP_ENV_FILE))
    for name in bp.to_prune(names, shipped, configured):
        for path in (name, name + bp.CHECKSUM_SUFFIX):
            if os.path.exists(os.path.join(bio.BUNDLE_DIR, path)):
                os.remove(os.path.join(bio.BUNDLE_DIR, path))
    left = bp.unshipped(os.listdir(bio.BUNDLE_DIR), shipped)
    bio.write_metrics(bio.textfile_dir(config), "backup_bundle_ship", {"txnet_backup_bundle_unshipped": len(left)})
    return left


def now():
    return datetime.datetime.now(datetime.timezone.utc).replace(microsecond=0)
