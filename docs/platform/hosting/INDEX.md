---
id: hosting
layer: platform
status: draft
version: 1
keywords: [hosting, origin pull, authenticated origin pulls, origin certificate, cloudflare firewall, cloudflare ranges, CF-Connecting-IP, client ip, real ip, visitor address, deploy, deployment, swarm, docker stack, rolling deploy, zero downtime, healthcheck, backup, database backup, postgres backup, pgbackrest, restore, point in time recovery, wal archive, pgbouncer, connection pool, too many clients, max_connections, log rotation, loki retention, json logs, request id, disk full, housekeeping, execution log growth, restart, server restart, service down, پشتیبان‌گیری, بکاپ دیتابیس, بازگردانی, ری‌استارت, سرویس دان شد, لاگ, پر شدن دیسک, استقرار, اتصال دیتابیس]
source: [dev-docker/traefik/dynamic/origin-pull.yml, dev-docker/traefik/plugins-local/**, dev-docker/traefik/origin-pull/**, scripts/edge/**]
owns_tables: []
depends_on: [automation, i18n]
updated: 2026-10-07
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
| [contract.origin.md](contract.origin.md) | the origin answering only Cloudflare: pull certificate, client address, firewall (EDGE-1-g, EDGE-1-h) — rules O1…O8 |
| [open-questions.md](open-questions.md) | the standby server (OPS-1-y) |

## Status

`draft`. Opened 2026-10-06 by ADR-0126 (D-62); the OPS-1 rows are `todo`.
EDGE-1-g (`contract.origin.md`) is built. The unit
claims `dev-docker/postgres/**`, `dev-docker/pgbouncer/**`, `swarm/**`,
`dev-docker/monitoring/config-dev/database.rules.yml` and `loki.yaml` in
`source:` as each row lands.

## Changelog
| Date | Change |
|---|---|
| 2026-10-06 | Unit opened by ADR-0126 — no code yet |
