---
id: hosting
layer: platform
status: draft
version: 1
keywords: [hosting, origin pull, authenticated origin pulls, origin certificate, cloudflare firewall, cloudflare ranges, CF-Connecting-IP, client ip, real ip, visitor address, deploy, deployment, swarm, docker stack, rolling deploy, zero downtime, healthcheck, backup, database backup, postgres backup, pgbackrest, restore, point in time recovery, wal archive, pgbouncer, connection pool, too many clients, max_connections, log rotation, loki retention, json logs, request id, disk full, housekeeping, execution log growth, restart, server restart, service down, پشتیبان‌گیری, بکاپ دیتابیس, بازگردانی, ری‌استارت, سرویس دان شد, لاگ, پر شدن دیسک, استقرار, اتصال دیتابیس]
source: [txnet-backend/shared-core/src/lib/logging/**, dev-docker/postgres/**, dev-docker/compose/pg-backup.yml, dev-docker/monitoring/config-dev/database.rules*.yml, dev-docker/traefik/dynamic/origin-pull.yml, dev-docker/traefik/plugins-local/**, dev-docker/traefik/origin-pull/**, scripts/edge/**]
owns_tables: []
depends_on: [automation, i18n]
updated: 2026-10-14
---

# hosting

**Responsibility (one sentence):** how the services run and survive — the
Swarm/compose stacks, Postgres's backup, tuning and connection pool, the log
pipeline's bounds and format, healthchecks, and housekeeping of operational
tables.
**Explicitly NOT responsible for:** uploaded files' backup (`object-storage`,
ADR-0120), Redis key layout (`redis-keyspace`), alert rules owned by a
business unit (`billing.rules.yml`, …), what a service does once it is up.

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | building any OPS-1 row — rules H1…H22 are the spec |
| [contract.origin.md](contract.origin.md) | the origin answering only Cloudflare: pull certificate, client address, firewall, private responses (EDGE-1-g, -h, -j) — rules O1…O11 |
| [open-questions.md](open-questions.md) | the standby server (OPS-1-y) |

## Status

`draft`. Opened 2026-10-06 by ADR-0126 (D-62); the OPS-1 rows are `todo`.
EDGE-1-g, -h, -j, -k and -m (`contract.origin.md`) are built; so is
OPS-1-k, -l and -z (H12/H13: `shared-core/src/lib/logging`, every Nest service, the gate, the queue),
and OPS-1-a (H1/H2: `main-db` archives WAL; `pgbackrest-repo.sh` writes the
repo settings to `conf.d/repo.conf`) and OPS-1-b (H3: `compose/pg-backup.yml`,
the shared-socket layout works, no `pgbackrest server` fallback) and OPS-1-c
(H4: `pg-backup.sh drill`, metric in its own `pg_restore_drill.prom`) and
OPS-1-f (H10: tuning on `main-db`'s `command:`, sizing rule in
`operations/environments.md`) and OPS-1-d (H5: `database.rules.yml` with
`promtool` tests; disk from `pg_data_fs.prom`, archive from `hosting_wal_archive`)
and OPS-1-e (H6: `operations/runbook-restore-database.md`, rehearsed on dev).
The unit claims `dev-docker/pgbouncer/**`, `swarm/**` and `loki.yaml` in
`source:` as each row lands.

## Changelog
| Date | Change |
|---|---|
| 2026-10-06 | Unit opened by ADR-0126 — no code yet |
