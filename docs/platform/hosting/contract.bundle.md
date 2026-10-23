---
id: hosting
layer: platform
status: active
version: 1
updated: 2026-10-23
---

# Contract — hosting: the whole platform as one file

OPS-1-ad (user, 2026-10-23). pgBackRest (H1–H4) and restic (ADR-0120) stay as
they are: continuous, point-in-time, on this server. The bundle is the other
thing: one encrypted file with everything a new server needs, made without
stopping the platform, sent to S3 by a separate script. Rules B1…B9. Code:
`scripts/bundle/`; runbook `operations/runbook-backup-bundle.md`.

## What a bundle is

**B1 — One file, named by its moment.** `txnet-backup-<project>-<YYYY-MM-DD_HH-MM-SS>Z.tar.zst.gpg`
in `/var/backups/txnet/bundles/` (`BACKUP_BUNDLE_DIR`), UTC, with
`<name>.sha256` beside it in `sha256sum -c` form. Written as `.partial` and
renamed last, so nothing ever reads half of one. Owner-only (0600, directory 0700).

**B2 — Contents.** `manifest.json` (format, time, project, host, commit, every
file's sha256, the figures of B3); `postgres/roles.sql` (`pg_dumpall
--roles-only`) and one `pg_dump -Fc -Z zstd:3` per database; `redis/dump.rdb`;
`rabbitmq/messages.json` (every queued message, read with requeue);
`volumes/<key>.tar` for every state volume not in B4's logical set (today
`object_storage`, `locales_runtime`); `keys.tar` — `move_plan.CARRIED_FILES`
except the passphrase. One classification of state for the move and the
bundle: a new compose volume stops both until it is classified.

**B3 — Consistent while live.** The main database is dumped from a snapshot
exported by an open `REPEATABLE READ` session, and its row counts are read in
that same snapshot, so they describe the dump exactly. The RDB is loaded once
in a throwaway Redis of memory-data's image (`redis-load.sh`) before it is
kept: a bundle whose Redis does not load fails when it is made.

**B4 — Logical volumes are never copied as files.** `postgres_data`,
`redis_vol_internal`, `rabbitmq_data`: a file copy of a running store is not
consistent. They come back through their service.

**B5 — Encrypted, keys inside, one passphrase outside** (user, 2026-10-23).
`gpg --symmetric --cipher-algo AES256` with `dev-docker/secrets/backup-bundle-passphrase`.
The passphrase is the only thing kept off the server besides the file; it is
never inside a bundle. A wrong one is refused before anything is touched.

## Making and shipping

**B6 — Nightly and on demand.** `txnet-backup.timer` at 03:00 UTC (after
pgBackRest 01:00 and restic 23:00) and `backup.py now`; one at a time (a lock).
Seven kept on disk; one not yet in S3 is never deleted while shipping is set up.
`backup.py install-timers` writes both units from the checkout's own path.

**B7 — Shipping is separate and write-only** (user, 2026-10-23). `ship.py`,
every 10 minutes, sends each unshipped bundle and then its `.sha256` with
rclone (`${DOCKER_REGISTRY}/rclone/rclone:1.71`), records it in `.shipped`.
The key in `dev-docker/secrets/backup-ship.env` may only `PutObject`: no
list, no delete, no HEAD (`--no-check-dest --s3-no-head`), so whoever takes
the server cannot erase S3. Retention in S3 is the bucket's lifecycle rule.

**B8 — Alerts** (`database.rules.yml`): `BackupBundleStale` — no bundle for
26h, or never (critical); `BackupBundleNotShipped` — two or more waiting for
1h, which is also what shipping never set up looks like (warning).

## Bringing one back

**B9 — Restore.** `backup.py verify` restores into throwaway containers and
compares, touching nothing. `backup.py restore` refuses code older than the
bundle's commit (or unrelated), and newer code without `--allow-newer-code`;
writes the keys and env files the checkout lacks and keeps — and reports —
any it has with other content; on a server holding data, needs `--replace` and
makes a safety bundle first (user, 2026-10-23). Then: every volume emptied and
unpacked, RabbitMQ's emptied, Redis loaded as AOF, each database dropped and
restored, `db-login-roles.sh` (this server's passwords), rows exact and Redis's
TTL-less keys exact (expiring ones may be fewer), the stack up, the messages
published back, a pgBackRest full started.
