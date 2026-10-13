---
id: hosting
layer: platform
status: draft
version: 1
updated: 2026-10-06
---

# Contract — hosting

The build spec for ADR-0126. Every OPS-1 row cites a rule here by number; a
value written here is decided, not a suggestion. Names in `code` are the ones
to use.

## TL;DR
Postgres is backed up continuously and the restore is proven weekly; every
pooled connection goes through PgBouncer; logs are bounded and JSON; Swarm
deploys start the new task before stopping the old.

## Backup and recovery

**H1 — Postgres image.** `dev-docker/postgres/Dockerfile`:
`FROM ${DOCKER_REGISTRY}/postgres:18-alpine`, `RUN apk add --no-cache pgbackrest`,
`COPY pgbackrest.conf /etc/pgbackrest/pgbackrest.conf`. `main-db` builds it as
`txnet/postgres:18`. Postgres flags on `command:`: `archive_mode=on`,
`archive_command='pgbackrest --stanza=txnet archive-push %p'`,
`archive_timeout=60`, `wal_level=replica`. The data volume is unchanged.

**H2 — pgBackRest config.** Stanza `txnet`; `pg1-path=/var/lib/postgresql/18/docker`;
`pg1-socket-path=/var/run/postgresql`; `repo1-retention-full=2`;
`compress-type=zst`; `process-max=2`; `start-fast=y`;
`repo1-cipher-type=aes-256-cbc` with the passphrase from secret file
`dev-docker/secrets/pg-backup-passphrase` (listed in `secrets/README.md`).
Repository by env, read by the entrypoint: `PG_BACKUP_REPO_TYPE` = `posix`
(default) | `s3` | `sftp`; `posix` uses `PG_BACKUP_LOCAL_DIR`
(default `/var/backups/txnet/pg`, a host bind like ADR-0120); `s3` uses
`PG_BACKUP_S3_ENDPOINT/BUCKET/REGION/KEY/SECRET`; `sftp` uses
`PG_BACKUP_SFTP_HOST/USER/PATH` + key file secret. `pg_hba`/roles unchanged:
pgBackRest connects over the local socket as `${MAIN_DB_USERNAME}`.

**H3 — `pg-backup` container.** Same image as H1, `entrypoint` a shell loop
(`dev-docker/postgres/pg-backup.sh`, the shape of `object-backup.sh`). Mounts:
`postgres_data` read-only, a shared named volume `pg_socket` at
`/var/run/postgresql` (also mounted by `main-db`), the repo dir, the passphrase
secret, `${NODE_TEXTFILE_DIR}` at `/textfile`. Runs as uid 70 (`postgres`).
First start: `stanza-create` if missing, then a full backup at once.
Schedule (UTC): `full` Sunday 01:00, `diff` other days 01:00. After each run
it writes `txnet_pg_backup_last_run_success`, `…_last_success_timestamp_seconds`,
`…_last_type` to `/textfile/pg_backup.prom`. **Fallback, decided now:** if a
backup cannot run in this shared-volume layout on dev, run `pgbackrest server`
inside `main-db` (a wrapper entrypoint starts it, then `exec`s
`docker-entrypoint.sh`) and point `pg-backup` at it with `pg1-host=main-db`,
`pg1-host-type=tls`; certs from `dev-docker/secrets/pgbackrest-tls/`.

**H4 — Restore drill.** `pg-backup.sh drill`, Sunday 06:00 UTC: `restore` the
latest set to `/drill` (tmpfs-free scratch dir in the container), start
`postgres -D /drill -p 55432 -c archive_mode=off` as uid 70, wait ready, run
as `${MAIN_DB_USERNAME}` (the superuser — RLS does not hide rows from it)
`SELECT max("createdAt") FROM billing.wallet_transaction` (the ledger) and
`SELECT count(*) FROM identity."user"`; pass when both return and the
ledger's max is within 26h of the backup's stop time or the table is empty.
Stop, delete `/drill`. Write `txnet_pg_restore_drill_last_success_timestamp_seconds`.
Manual: `docker exec txnet-pg-backup sh /usr/local/bin/pg-backup.sh drill`.

**H5 — Alerts** (`dev-docker/monitoring/config-dev/database.rules.yml`, mounted
like `storage.rules.yml`): `PgBackupFailed` last run 0 for 5m; `PgBackupStale`
no success for 36h; `PgRestoreDrillStale` no drill success for 8d;
`PgArchiveFailing` from a postgres-exporter query on `pg_stat_archiver`:
`failed_count` rose and `last_failed_time > last_archived_time` for 15m;
`PgWalDiskHigh` the Postgres volume's filesystem over 80% (node-exporter).
Each routes to the existing Alertmanager receiver.

**H6 — Runbook** `docs/operations/runbook-restore-database.md`: full restore,
point-in-time restore (`--type=time --target="…"`), restore to a new server,
where the passphrase lives, and "test it on dev first". Template in
`operations/INDEX.md`.

## Connections

**H7 — `db-pool` (PgBouncer).** `dev-docker/pgbouncer/Dockerfile`:
`FROM ${DOCKER_REGISTRY}/alpine:latest`, `apk add --no-cache pgbouncer`. An
entrypoint writes `pgbouncer.ini` and `userlist.txt` (plaintext passwords from
`DB_APP_PASSWORD`, `DB_CROSS_TENANT_PASSWORD`, `DB_AI_READER_PASSWORD`; file
mode 600, on tmpfs) then `exec pgbouncer`. Settings: `listen_port=6432`,
`pool_mode=transaction`, `auth_type=scram-sha-256`, `max_client_conn=2000`,
`default_pool_size=20`, `reserve_pool_size=5`, `reserve_pool_timeout=3`,
`max_prepared_statements=200`, `server_reset_query=` (empty),
`ignore_startup_parameters=extra_float_digits,options`,
`server_idle_timeout=300`. One `[databases]` entry: `${MAIN_DB_NAME}` →
`main-db:5432`. Healthcheck: `pg_isready -h 127.0.0.1 -p 6432`. Never
published on the host.

**H8 — Connection budget** (Postgres `max_connections=100`):

| through `db-pool` | client setting |
|---|---|
| every Prisma URL in `DATABASE_APP_URL`, `DATABASE_CROSS_TENANT_URL`, `DATABASE_AI_READER_URL` | host `db-pool:6432`, `?pgbouncer=true&connection_limit=5&pool_timeout=20` |
| network-service, sub-service pools | `NETWORK_DB_POOL_MAX_CONNS=5`, `SUB_DB_POOL_MAX_CONNS=5`, host `db-pool:6432` |

Server side: 3 roles × (20 + 5 reserve) = 75 at most.

| direct to `main-db:5432` | count |
|---|---|
| `LISTEN`: auth-service `PERMISSIONS_LISTEN_CLIENT` (`auth.module.ts`), network-service `WakeListener`, sub-service `invalidate.Listener` — each reads new `DATABASE_LISTEN_URL` | 3 |
| migrations (`DATABASE_URL`, owner), postgres-exporter, `pg-backup` (2) | 4 |
| operator `psql` | ≤ 5 |

Total ≤ 87 of 100. A new pooled role adds 25 and must update this table.

**H9 — Pool safety, checked by a test.** `tools/conventions.py` gains a check
that fails on `SET ` (session), `set_config(…, false)` and `pg_advisory_lock(`
(session lock) in any `*.ts`/`*.go` outside specs. All three break silently
behind transaction pooling.

**H10 — Postgres tuning** on `main-db`'s `command:`, each from env with this
default: `shared_buffers=${PG_SHARED_BUFFERS:-512MB}`,
`effective_cache_size=${PG_EFFECTIVE_CACHE_SIZE:-1536MB}`,
`work_mem=${PG_WORK_MEM:-16MB}`, `maintenance_work_mem=${PG_MAINTENANCE_WORK_MEM:-128MB}`,
`max_wal_size=2GB`, `checkpoint_completion_target=0.9`, `random_page_cost=1.1`,
`log_min_duration_statement=${PG_SLOW_MS:-500}`, `max_connections=100`.
Container: `shm_size: 256mb`, `stop_grace_period: 60s`. Rule for production:
`shared_buffers` = 25% and `effective_cache_size` = 75% of the memory given to
Postgres; written in `operations/environments.md`.

## Logs

**H11 — Rotation and retention.** `docker-compose.main.yml`'s services all use
one anchor `x-logging: {driver: json-file, options: {max-size: "10m", max-file: "3"}}`
(dev already does). Loki gets `dev-docker/monitoring/config-dev/loki.yaml`:
`compactor.retention_enabled: true`, `limits_config.retention_period: 720h`,
`limits_config.ingestion_rate_mb: 8`. Its port binds `127.0.0.1:${LOKI_PORT}`.

**H12 — JSON lines from Node.** `shared-core` `JsonLogger implements LoggerService`:
one line per call, keys `time` (ISO), `level` (`INFO`/`WARN`/`ERROR`/`DEBUG`,
as slog), `msg`, `service` (`APP_NAME`), `context`, and when known `requestId`,
`tenantId`, `userId`; an error adds `err` (message) and `stack`. `LOG_FORMAT`
= `json` (default when `NODE_ENV=production`) | `pretty` (Nest's logger).
Installed by `shared-core`, once: every `main.ts` boots with `createNestApp`
(`createNestContext` for worker and metering), which buffers boot lines until
`app.useLogger(app.get(JsonLogger))`; every `AppModule` imports
`JsonLoggerModule`. `APP_NAME`/`LOG_FORMAT` are validated in `logging/env.ts`,
not in each `envSchema`; `APP_NAME` is required (the image sets it).

**H13 — Request id.** `shared-core` `RequestIdMiddleware`, installed by
`createNestApp` with `app.use` so it runs before every module's middleware:
takes `X-Request-Id` if it is 8–128 chars of `[A-Za-z0-9-]`, else a new UUID v4;
holds it, and the gate's `X-User-Id`, in an `AsyncLocalStorage` the logger
reads; sets it on the response. At the edge `auth-handler` does the same
(`middlewares.RequestID`, Go `slog` lines add `requestId` from the context) and
both gates forward it (OPS-1-z). A call to another service sends
`serviceCallHeaders(token)`, which forwards it (C-27; `codeshape.py`
`raw-service-call`). An outbox event written inside a request gets it in
`outbox_event.requestId` (the `withTenant` extension stamps it; a
`CrossTenantPrismaService` write does not), and the relay publishes it as the
message header `x-request-id`; every consumer runs inside `inMessageScope`, so
the message's id is in scope before it logs. Promtail parses JSON and labels
only `level` (and `service`); `tenantId`, `requestId` are queried with `| json`.

## Data growth

**H14 — `automation_housekeeping` Job** (worker-service, `30 2 * * *` UTC):
1. `bot_execution_log`: per `botWorkerId` (its index), delete rows with
   `startedAt < now − AUTOMATION_LOG_KEEP_DAYS` (default 30) and
   `status = success`, and `status IN (failed, partial)` older than
   `AUTOMATION_LOG_KEEP_FAILED_DAYS` (default 90);
2. `outbox_event`: `publishedAt IS NOT NULL AND publishedAt < now − OUTBOX_KEEP_DAYS`
   (default 7), via the `(publishedAt, occurredAt)` index; never an unpublished row;
3. each delete in batches of 5,000 (`DELETE … WHERE id IN (SELECT id … LIMIT 5000)`)
   until a batch removes fewer; stops at 10 minutes and reports what is left.
Safe to run twice. `itemsProcessed` = rows deleted. The first run on a large
table is the same loop — no special migration.

## Restart and deploy

**H15 — Healthchecks.** Services with HTTP missing `/health` get the
`health.controller.ts` that billing-service has (auth-service, bot-service).
worker-service and metering-service (no HTTP, ADR-0027) write
`/tmp/healthy` every 15s while their broker channel is open; their check is
`test $(( $(date +%s) - $(stat -c %Y /tmp/healthy) )) -lt 60`. HTTP check:
`node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/'+(process.env.GLOBAL_PREFIX||'api')+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"`.
Interval 10s, timeout 3s, retries 3, `start_period` 60s. `/health` answers 200
when the process is up and `SELECT 1` on its pool succeeds, else 503.

**H16 — Swarm stack.** `swarm/docker-stack.yml` is complete on its own (no
second file): every service of `docker-compose.main.yml`, `image:` tags from
`${IMAGE_TAG}` (no `build:` in Swarm), `deploy.replicas: 1`,
`deploy.update_config: {parallelism: 1, order: start-first, failure_action: rollback, monitor: 30s}`
(data stores — `main-db`, `memory-data`, `rabbitmq` — use `order: stop-first`:
two writers on one volume corrupt it), `deploy.restart_policy: {condition: any, delay: 5s}`,
`deploy.resources.limits.memory` = the dev ceilings, Traefik labels under
`deploy.labels`, Traefik with `--providers.swarm` replacing `--providers.docker`,
secrets (`vault-kek`, passphrases) as Swarm `secrets:`. Checked with
`docker stack config -c swarm/docker-stack.yml` — never deployed by an agent on
this host (it runs the user's live site; `docker swarm init` changes the host).
`scripts/prod.stack.sh` deploys it; `scripts/prod.compose.sh` stays until the
cutover (OPS-1-o) and is then removed.

**H17 — Translations from disk.** The Node locale client takes `cacheDir`
(env `LOCALE_CACHE_DIR`, default `/var/cache/txnet-locale`). After every
snapshot it writes `<scope>.<lang>.json` atomically (temp file + rename). If
`boot()` reaches its deadline, it loads every cached file for its scope; if at
least one loads it logs `WARN locale-service unreachable, booted from cache
(<age>)`, starts Watch (which refetches on connect) and resolves; with none it
throws as today. Named volume `locale_cache` mounted by every Node service.
The Go client (`i18n-platform/clients/go`) does the same with `Config.CacheDir`
(same env, same file names): `New` returns a client when the cache loaded, and
`auth-handler` mounts the volume.

**H18 — Tick window.** In `TickPublisher.tick()`, when `registry.schedulable()`
throws, set `this.since = since` before returning, so the next tick asks for
the whole span. A publish failure for one worker is unchanged.

**H19 — Stale bot updates.** `bot-service` adds `receivedAt` (ISO) to every
`BotUpdateMessage` it publishes. Its dispatch route, before the flow: if
`now − receivedAt > BOT_UPDATE_STALE_MS` (default 600000), the flow does not
run; a callback query is answered with the text of key `bot.common.stale_update`;
a message gets that text as a reply only if Redis key
`RedisKeys…bot:stale-notice:<botId>:<chatId>` (`SET NX EX 600`) was absent.
The route answers `{dispatched: true, stale: true}`. A message with no
`receivedAt` (published before the deploy) is fresh. Keys fa/en added to
`locales/`.

**H20 — Reconnect.** gateway-service closes every socket on shutdown with
`1012` ("service restart") instead of `GoingAway`. The panel client: on `1012`
or `1006`, the first attempt waits `random(0, 10000)` ms; every later attempt
waits `random(0, min(30000, 500 × 2^attempt))` (full jitter). `4401`, `4403`
and the too-many code keep their meaning.

**H21 — Broker and Redis watch.** RabbitMQ: enable `rabbitmq_prometheus`
(`dev-docker/rabbitmq/enabled_plugins`), scrape `:15692`; alerts
`RabbitAlarm` (`rabbitmq_alarms_memory_used_watermark` or
`…_free_disk_space_watermark` = 1, 1m), `BotUpdateBacklog` (ready messages on
`txnet.automation.bot.update.*` > 500 for 5m). Redis: `--maxmemory ${REDIS_MAXMEMORY:-768mb}`,
`--maxmemory-policy noeviction` (explicit); `redis-exporter`
(`${DOCKER_REGISTRY}/oliver006/redis_exporter:v1.62.0`, verified on the
mirror); alert `RedisMemoryHigh` used/max > 0.8 for 10m. Rules in
`database.rules.yml`.

## Later

**H22 — Standby (OPS-1-y).** A streaming replica on a second server, fed from
the same pgBackRest repository (`archive-get` + `primary_conninfo`), promoted
by the runbook in H6. Blocked until the server exists.

## Consumes
| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| automation | the `Job` contract and registry | housekeeping does not run; tables grow, nothing breaks |
| i18n | snapshots to cache | H17: boots from cache, or fails as today |
