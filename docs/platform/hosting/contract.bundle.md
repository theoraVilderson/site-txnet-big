---
id: hosting
layer: platform
status: active
version: 1
updated: 2026-10-24
---

# Contract — hosting: the whole platform as one file

OPS-1-ad (user, 2026-10-23). pgBackRest (H1–H4) and restic (ADR-0120) stay as
they are: continuous, point-in-time, on this server. The bundle is the other
thing: one encrypted file with everything a new server needs, made without
stopping the platform, sent to S3 by a separate script. Rules B1…B10. Code:
`scripts/bundle/`; runbook `operations/runbook-backup-bundle.md`.

## What a bundle is

**B1 — One file, named by its moment.** `txnet-backup-<project>-<YYYY-MM-DD_HH-MM-SS>Z.tar.zst.gpg`
in `/var/backups/txnet/bundles/` (`BACKUP_BUNDLE_DIR`), UTC, with
`<name>.sha256` beside it in `sha256sum -c` form. Written as `.partial` and
renamed last, so nothing ever reads half of one. Owner-only (0600, directory 0700).

**B2 — Contents.** `manifest.json` (format, time, project, host, commit, every
file's sha256, the figures of B3); `postgres/roles.sql` (`pg_dumpall
--roles-only`) and one `pg_dump -Fc -Z zstd:3` per database; `redis/dump.rdb`;
`rabbitmq/messages.json` (every queued message, read with requeue) and
`rabbitmq/definitions.json` (users with password hashes, vhosts, permissions,
policies, queues — `rabbitmqctl export_definitions`);
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
never inside a bundle, nor sealed in the repo (S1). The node's age key is
inside, at its absolute path (`/etc/txnet/age.key`, `key_tar_args`): it opens
the sealed secrets a restored checkout carries (S3). A wrong one is refused before anything is touched.

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
makes a safety bundle first (user, 2026-10-23) — "holds data" is anything in
the Postgres volume, since PG 18 keeps its cluster in `18/docker/`. Then: every
image built one at a time, bounded and retried, before anything stops; every
volume emptied and unpacked, RabbitMQ's emptied, Redis loaded as AOF; the
three data services up and healthy **before anything else** (a broker booting
beside the compiling services timed out its first boot and kept a user with no
rights); the definitions imported and the env's user set from this server's
env; each database dropped and restored, `db-login-roles.sh` (this server's
passwords); rows exact and Redis's TTL-less keys exact (expiring ones may be
fewer); the stack up, the messages published back (a failure there is
reported, not fatal), a pgBackRest full when data was replaced.

## On Kubernetes

**B10 — The same bundle, through kubectl and claims** (OPS-1-o-k; user,
2026-10-23: the cutover is a compose server's bundle restored into the
cluster, and the same tool is the cluster's disaster recovery). `--stack k8s`
on `backup.py`, `ship.py` and `install-timers` works in namespace `txnet` with
`KUBECTL` (default `kubectl`); B1–B9 hold unchanged, and a bundle made on
either side restores on the other. `bundle_stack.py` is the one interface both
sides answer; `bundle_k8s.py` the cluster's answers:

- **Where things run.** A command in a service runs in its workload's container
  (`kubectl exec`; `pg-backup` in `main-db`'s pod, K3). A throwaway container is
  a pod labelled `app.kubernetes.io/name=txnet-bundle` — never `part-of`, so no
  prune or stop selects it — with no API token, deleted at the end. A file
  volume is its claim mounted at `/data` in one (K7); ship's rclone pod mounts
  the bundle directory read-only from the node the script runs on, its S3
  settings on stdin (never in a pod spec). The drill's Postgres listens on no
  address. The model is the renderer's (K2), from the sealed secrets opened in
  `/dev/shm` when the checkout has them (S4), removed on exit.
- **Files go in whole and counted.** Into a pod a file is written, counted
  (`wc -c`) and compared, then run from there (`pg_restore`, `psql -f`, `tar
  -xpf`); never streamed into a command's stdin. On k3s 1.34 `kubectl exec -i`
  into a command that ends at its input's end lost the tail of 5 MB in most runs,
  over WebSockets and SPDY alike; with the count printed after, all 11 of 5 and
  60 MB arrived. A pod's output to this host arrived whole (5 of 60 MB).
- **Restore.** The cluster is deployed first (`prod.k8s.sh deploy` at the
  bundle's commit): the node pulls, it never builds (K14). "Holds data" is users
  in the main database, since db-migrate seeds rows into every cluster. The stop
  scales every Deployment and StatefulSet to zero and waits for their pods; each
  keeps its replicas in `txnet.io/replicas-before-restore`, so a restore run
  again after one that failed still brings back what ran — and finds the stores
  down, so it brings them up to ask them. The stores come up alone first, then
  the rest; the login roles are made as `deploy` makes them (R11); RabbitMQ's
  API is reached through `kubectl port-forward`.
- **Keys.** A file with a sealed copy is that copy, opened: compared with the
  bundle's and reported when it differs, never overwritten (S4 reads only it).
  A file with none is B9's rule. The age key rides in the bundle as before (B5).
- **The main database is this server's.** Each database restores under its own
  name, so a bundle whose main database is not the one this server's
  `MAIN_DB_NAME` names is refused before anything stops: dev's `devtxnet`
  restored into a cluster rendered from `.env.prod` passed its own counts and
  left the services reading an empty `prodtxnet`.

Proven 2026-10-24 in a throwaway k3s (the three stores rendered from the
production model, a stand-in Deployment) and MinIO: dev's compose bundle
restored into the cluster — 242 tables, Redis, 2 of 2 queued messages, both file
volumes identical by content, 1426 users, `txnet_app_user` signing in with
`.env.prod`'s password — including a run after one that had failed half-way;
a restore without `--replace` refused on the cluster holding that data, and with
it made a safety bundle from the cluster, restored and started the pgBackRest
full (174s); `verify --stack k8s` of the cluster's bundle passed in 58s; `ship`
sent both from a pod with a put-only key, byte-identical in the bucket. Tests:
`scripts/bundle/test_bundle_k8s.py`.

