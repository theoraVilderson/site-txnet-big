---
id: hosting
layer: platform
status: active
version: 1
updated: 2026-10-24
---

# Contract — hosting: Postgres backups off the node

H1–H4 back Postgres up into one repository on this server. This file adds the
second one, on S3, so a lost disk loses minutes of data, not the day since the
nightly bundle (ADR-0164 point 1, OPS-1-o-o). The bundle (B6, B7) is unchanged
and remains the restore of everything else. Restore steps:
`operations/runbook-restore-database.md` 3d.

**K15 — Backups off the node.**

- **Where.** `repo2`, type `s3`, exists exactly when `PG_BACKUP_REPO2_S3_BUCKET`
  is set, beside whatever H2 made `repo1`: `_ENDPOINT`, `_REGION`, `_KEY`,
  `_SECRET`, `_URI_STYLE` (`host` default, `path` for MinIO and most non-AWS
  stores), path `/txnet`, `aes-256-cbc` with H2's passphrase.
  `pgbackrest-repo.sh` writes it into `conf.d/repo.conf` in `main-db` and
  `pg-backup` alike; a repo2 missing a variable stops the container, naming it.
- **What.** `archive-push` sends every WAL segment to both. `pg-backup.sh`
  backs up each repository in turn on H3's schedule; the run's metric is 1 only
  when every one succeeded, so an S3 that refuses a backup is H5's
  `PgBackupFailed`. At start, each repository with no backup gets its full then,
  so a repo2 added later does not wait for Sunday.
- **The lock** (user, 2026-10-24). The bucket has versioning and object lock in
  compliance mode for `PG_BACKUP_REPO2_LOCK_DAYS` (30), and a lifecycle rule
  that removes noncurrent versions after one day. pgBackRest must list and
  expire, so its key can delete: the lock, not the key, is what protects the
  data — B7's write-only rule does not hold for this repository.
  `repo2-retention-full-type=time` at the same days, so expire only ever asks
  to delete what the lock has released. A delete inside the window, by expire
  or by whoever holds the key, adds a delete marker; the version stays until
  its lock lapses, and removing the marker brings it back.
- **An S3 outage never stops Postgres** (user, 2026-10-24). With repo2 set,
  `archive-async=y` and `archive-push-queue-max=8GiB`. While S3 is down, repo1
  still receives each segment, Postgres keeps the WAL and retries, and
  `PgArchiveFailing` fires at 15 minutes. Past 8 GiB waiting, the WAL is
  acknowledged and dropped: a gap in point-in-time recovery, closed by the next
  backup, instead of `pg_wal` filling the 50 GiB disk (archive_timeout=60
  writes up to ~23 GiB a day). Without repo2 nothing here changes.
- **The drill.** H4 restores from repo1 on schedule; `pg-backup.sh drill 2`
  restores the same way from S3.

Proven 2026-10-24 against a throwaway MinIO with a 30-day compliance lock:
a full and a diff in both repositories; `drill 2` passed, and a restore from
repo2 replayed its WAL to the live row count (1500 = 1500); deleting a locked
version was refused as WORM, even with the root key, a plain delete left a
marker and removing it restored the object; with S3 stopped repo1 took the
next segment while the archiver retried, and S3 back, repo2 caught up on its
own; a new empty repo2 got its full at the loop's start, repo1 none. Test:
`dev-docker/postgres/test_pgbackrest_repo.py` (the written settings).

## Consumes

H1–H5 in `contract.md`; ADR-0164.
