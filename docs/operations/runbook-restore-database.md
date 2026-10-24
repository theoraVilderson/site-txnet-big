---
id: runbook-restore-database
status: active
updated: 2026-10-24
---

# Runbook — restore the database

Postgres (`main-db`) archives every WAL segment with pgBackRest into one
repository (hosting `contract.md` H1–H4, ADR-0126): a full backup every Sunday,
a differential every other night, two fulls kept. In production a second
repository, `repo2` on S3 under a 30-day object lock, gets the same
(`contract.backup.md` K15). This restores it whole, to a moment in time, onto a
new server, or from S3 when this server's disk is gone.

**Rehearse on dev first.** Every command below works unchanged with
`COMPOSE=scripts/dev.compose.sh`; a restore you have not run once is not one
you can run under pressure.

```bash
COMPOSE=scripts/prod.compose.sh     # dev: scripts/dev.compose.sh
```

## Symptom

Data is gone or wrong (a dropped table, a bad migration, a mistaken bulk
update), or `main-db` will not start on its volume, or the server is lost.
A lost server with a backup bundle in S3 comes back whole — Redis, files,
keys too — by `runbook-backup-bundle.md`; this runbook is Postgres alone.

## How it pages

Nothing pages for lost data; a person notices. What does page is the backup
being unusable when you need it (`database.rules.yml`): `PgBackupFailed`,
`PgBackupStale`, `PgRestoreDrillStale`, `PgArchiveFailing`. Read those first —
they say how far back a restore can reach.

## First 3 checks

1. **The repository answers and holds what you need** — the backups, and WAL
   up to the moment you want:
   ```bash
   $COMPOSE exec pg-backup gosu postgres pgbackrest --stanza=txnet info
   ```
   A point-in-time target must lie after the oldest backup's stop time and
   before the newest archived WAL (`wal archive min/max`).
2. **The passphrase is there.** `dev-docker/secrets/pg-backup-passphrase` on
   the server; its copy is kept wherever `vault-kek` is kept
   (`dev-docker/secrets/README.md`). Without it every backup is unreadable —
   a wrong one reads as "backup.info cannot be opened".
3. **When it went wrong, in UTC.** For a bad statement: `docker logs` of the
   service that ran it, or Postgres's own log (statements over `PG_SLOW_MS`
   are logged). Pick a target a few seconds *before* it.

## Mitigation

### 1. Stop the writers, keep `main-db` up long enough to archive

```bash
# the list is what step 4 starts again — exactly these, nothing more
$COMPOSE ps --services | grep -vx main-db > /tmp/restore-stopped-services
xargs $COMPOSE stop < /tmp/restore-stopped-services
# push the current WAL segment out, so the archive ends where the database does
$COMPOSE exec main-db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select pg_walfile_name(pg_switch_wal())"'
$COMPOSE exec main-db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Atc "select last_archived_wal, failed_count from pg_stat_archiver"'
$COMPOSE stop main-db
```

The second query must name the segment the first printed. If `main-db` is
already down or broken, skip to stopping it: the archive ends at the last
segment it pushed.

### 2. Move the current data aside

Keeps the broken state for the root cause, and gives `restore` the empty
directory it needs. It costs the database's size again in disk; if the disk
cannot hold it, add `--delta` to the restore below instead (overwrites in place).

```bash
$COMPOSE run --rm --no-deps --entrypoint sh main-db -c \
  'mv /var/lib/postgresql/18/docker /var/lib/postgresql/18/docker.before-restore-$(date -u +%Y%m%dT%H%M)'
```

### 3a. Whole — to the newest archived WAL

```bash
$COMPOSE run --rm --no-deps --entrypoint sh main-db -c \
  'sh /usr/local/bin/pgbackrest-repo.sh && install -d -o postgres -g postgres -m 700 /var/lib/postgresql/18/docker \
   && gosu postgres pgbackrest --stanza=txnet restore'
$COMPOSE up -d main-db
$COMPOSE logs -f main-db     # wait for "archive recovery complete", then "ready to accept connections"
```

### 3b. To a point in time

Same, with a target, pausing there so the data can be checked before it is
committed to:

```bash
$COMPOSE run --rm --no-deps --entrypoint sh main-db -c \
  'sh /usr/local/bin/pgbackrest-repo.sh && install -d -o postgres -g postgres -m 700 /var/lib/postgresql/18/docker \
   && gosu postgres pgbackrest --stanza=txnet --type=time --target="2026-10-14 12:58:34+00" --target-action=pause restore'
$COMPOSE up -d main-db
$COMPOSE logs main-db | grep -E "recovery stopping|pausing"
```

Paused, it answers read-only queries: look at the rows that matter. Then:

- **right** — promote it:
  `$COMPOSE exec main-db sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "select pg_wal_replay_resume()"'`;
  `select pg_is_in_recovery()` turns `f` and the log says `selected new timeline ID`.
- **wrong target** — nothing is committed yet: `$COMPOSE stop main-db`, delete
  `/var/lib/postgresql/18/docker` the way step 2 moved it, and repeat 3b with
  another `--target`.

### 3c. Onto a new server

1. Install Docker, check out the deployed commit, put `.env` and `.env.prod` in
   place, and the passphrase at `dev-docker/secrets/pg-backup-passphrase`.
2. Reach the repository. `s3`/`sftp`: the same `PG_BACKUP_*` env, nothing to
   copy. `posix`: copy it — `rsync -a <old-host>:/var/backups/txnet/pg/ /var/backups/txnet/pg/`.
3. **Make sure the old server's `main-db` is stopped.** Two servers archiving
   into one repository fork it.
4. `$COMPOSE build main-db`, check 1 above (`info`), then 3a or 3b — step 2 is
   not needed, the new volume is empty. In step 4, `$COMPOSE up -d` in place
   of `start`: nothing exists yet to start.

### 3d. From S3 (repo2) — this server's repository is gone or damaged

pgBackRest restores from the first repository that holds a backup; name repo2
to take it from S3. Every step of 3a/3b/3c is the same, with `--repo=2`:

```bash
$COMPOSE run --rm --no-deps --entrypoint sh main-db -c \
  'sh /usr/local/bin/pgbackrest-repo.sh && gosu postgres pgbackrest --stanza=txnet --repo=2 info'
$COMPOSE run --rm --no-deps --entrypoint sh main-db -c \
  'sh /usr/local/bin/pgbackrest-repo.sh && install -d -o postgres -g postgres -m 700 /var/lib/postgresql/18/docker \
   && gosu postgres pgbackrest --stanza=txnet --repo=2 restore'
```

The restore writes `--repo=2` into `restore_command`, so the WAL replays from S3
too. To prove the S3 copy reads without touching anything:
`$COMPOSE exec pg-backup sh /usr/local/bin/pg-backup.sh drill 2`.

**`info` shows fewer backups than it should** — someone, or an expire, deleted
them inside the lock: each object is hidden behind a delete marker, not gone.
List the markers and remove them (S3's CLI, the bucket's own key):

```bash
aws s3api list-object-versions --bucket <bucket> --prefix txnet/ \
  --query 'DeleteMarkers[].[Key,VersionId]' --output text   # add --endpoint-url for a non-AWS store
aws s3api delete-object --bucket <bucket> --key <Key> --version-id <VersionId>   # per marker
```

A locked version itself cannot be deleted by anyone until its lock lapses.

**Setting up the bucket** (once, OPS-1-p names it): create it with object lock
(which turns versioning on), set the default retention, and a lifecycle rule
so what expire deletes is removed a day later instead of kept forever:

```bash
aws s3api create-bucket --bucket <bucket> --object-lock-enabled-for-bucket
aws s3api put-object-lock-configuration --bucket <bucket> --object-lock-configuration \
  '{"ObjectLockEnabled":"Enabled","Rule":{"DefaultRetention":{"Mode":"COMPLIANCE","Days":30}}}'
aws s3api put-bucket-lifecycle-configuration --bucket <bucket> --lifecycle-configuration \
  '{"Rules":[{"ID":"expired","Status":"Enabled","Filter":{},"NoncurrentVersionExpiration":{"NoncurrentDays":1},"Expiration":{"ExpiredObjectDeleteMarker":true}}]}'
```

Then the five `PG_BACKUP_REPO2_S3_*` in `.env.prod` (sealed, S1) and a restart
of `main-db` and `pg-backup`: the loop's start makes repo2's first full.

### 4. Bring everything back and back it up

```bash
xargs $COMPOSE start < /tmp/restore-stopped-services
$COMPOSE exec pg-backup sh /usr/local/bin/pg-backup.sh full
```

`start`, not `up -d`: `up` also recreates any service whose config changed
since it last ran, and one name conflict aborts it halfway (dev, 2026-10-14).

A restore that ends with a promotion starts a new timeline; a full backup at
once is the baseline every later point-in-time restore will start from. Once
the services are confirmed healthy, delete what step 2 moved aside:

```bash
$COMPOSE exec main-db sh -c 'rm -rf /var/lib/postgresql/18/docker.before-restore-*'
```

## Root-cause notes

- A restore reaches back to the oldest of the two fulls kept, at most ~2 weeks.
- `PgArchiveFailing` while data was lost means the restore ends at the last
  archived segment, not at the moment of the loss.
- With repo2, an S3 outage longer than 8 GiB of WAL drops segments rather than
  fill the disk (K15): a point-in-time restore cannot land inside that gap; one
  after the next backup can.
- The weekly drill (`pg-backup.sh drill`, H4) restores the newest backup into a
  scratch directory; it proves the backups read, not this runbook's steps.

## Owner

`hosting` (`docs/platform/hosting/`). Rehearsed on dev 2026-10-14: steps 1, 2,
3a and 4 on dev's own `main-db` (row counts and newest rows identical after);
3b to `2026-10-14 12:58:34+00` and 3c from a copy of the repository into fresh
volumes, the target checked against marker rows before and after it. 3d's
pgBackRest commands ran against a throwaway MinIO with a 30-day compliance lock,
2026-10-24, inside a scratch Postgres rather than through `$COMPOSE`, and its
markers were removed with MinIO's `mc`; the `aws s3api` lines are not yet run
anywhere — OPS-1-p runs them on the chosen store.
