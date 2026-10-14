---
id: hosting
layer: platform
status: draft
version: 1
keywords: [hosting, origin pull, authenticated origin pulls, origin certificate, cloudflare firewall, cloudflare ranges, CF-Connecting-IP, client ip, real ip, visitor address, deploy, deployment, swarm, docker stack, rolling deploy, zero downtime, healthcheck, backup, database backup, postgres backup, pgbackrest, restore, point in time recovery, wal archive, pgbouncer, connection pool, too many clients, max_connections, log rotation, loki retention, json logs, request id, disk full, housekeeping, execution log growth, restart, server restart, service down, پشتیبان‌گیری, بکاپ دیتابیس, بازگردانی, ری‌استارت, سرویس دان شد, لاگ, پر شدن دیسک, استقرار, اتصال دیتابیس]
source: [txnet-backend/shared-core/src/lib/logging/**, dev-docker/postgres/**, dev-docker/compose/pg-backup.yml, dev-docker/pgbouncer/**, dev-docker/compose/db-pool.yml, dev-docker/compose/logging.yml, dev-docker/monitoring/config-dev/loki.yaml, dev-docker/monitoring/config-dev/database.rules*.yml, dev-docker/traefik/dynamic/origin-pull.yml, dev-docker/traefik/plugins-local/**, dev-docker/traefik/origin-pull/**, scripts/edge/**]
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

`draft`. Opened 2026-10-06 by ADR-0126 (D-62). Built: EDGE-1-g, -h, -j, -k,
-m (`contract.origin.md`); OPS-1-k, -l, -z (H12/H13, `shared-core/src/lib/logging`
in every Nest service, the gate, the queue); OPS-1-a (H1/H2, WAL archived,
`pgbackrest-repo.sh` → `conf.d/repo.conf`); -b (H3, `compose/pg-backup.yml`,
shared socket); -c (H4, `pg-backup.sh drill`, `pg_restore_drill.prom`); -f
(H10, `main-db` `command:`, sizing in `operations/environments.md`); -d (H5,
`database.rules.yml` + `promtool` tests); -e (H6, restore runbook, rehearsed);
-g (H9, C-41's check); -h (H7, `db-pool`: PgBouncer 1.25.2, own user, tmpfs);
-i (H8, every pooled URL on `db-pool`, 5 `LISTEN`s direct; 15 of 100 on dev);
-j (H11, `compose/logging.yml` on all 28 services, `loki.yaml` 30 days, loopback).
`swarm/**` joins `source:` as its row lands.

## Changelog
| Date | Change |
|---|---|
| 2026-10-06 | Unit opened by ADR-0126 — no code yet |
