---
id: hosting
layer: platform
status: active
version: 1
keywords: [hosting, cluster node, add node to cluster, کلاستر, سرور جدید کلاستر کنم, نود اضافه کنم به کلاستر, اضافه کردن نود کلاستر, نود k3s, national internet, internet shutdown, domestic door, arvancloud door, two doors, اینترنت ملی, نت ملی, ملی شدن اینترنت, قطع اینترنت بین الملل, کلودفلر قطع, فروش تو ایران, آروان, backup bundle, backup now, full backup, one backup file, backup to s3, ship backups, s3 upload, restore bundle, write-only key, بک آپ همون لحظه, بک آپ کامل, فایل بک آپ, بک آپ فشرده, فرستادن بک آپ به s3, بک آپ داخل s3, بالا آوردن بک آپ, سرور خراب شد, server move, move server, migrate server, new datacenter, datacenter move, cutover, presync, rabbitmq node name, انتقال سرور, جابه‌جایی سرور, جا به جایی سرور, دیتاسنتر, بردن به دیتاسنتر دیگر, از یه دیتاسنتر برم یه دیتاسنتر, بک آپ دوباره برگردونم, انتقال ردیس, origin pull, authenticated origin pulls, origin certificate, cloudflare firewall, cloudflare ranges, CF-Connecting-IP, client ip, real ip, visitor address, deploy, deployment, kubernetes, k8s, k3s, k3d, kustomize, rolling deploy, zero downtime, healthcheck, backup, database backup, postgres backup, pgbackrest, restore, point in time recovery, wal archive, pgbouncer, connection pool, too many clients, max_connections, log rotation, loki retention, json logs, request id, disk full, housekeeping, execution log growth, restart, server restart, service down, پشتیبان‌گیری, بکاپ دیتابیس, بازگردانی, ری‌استارت, سرویس دان شد, لاگ, پر شدن دیسک, استقرار, اتصال دیتابیس]
source: [txnet-backend/shared-core/src/lib/logging/**, dev-docker/postgres/**, dev-docker/compose/pg-backup.yml, dev-docker/compose/data.yml, dev-docker/pgbouncer/**, dev-docker/compose/db-pool.yml, dev-docker/compose/logging.yml, dev-docker/compose/health.yml, txnet-backend/shared-core/src/lib/health/**, dev-docker/monitoring/config-dev/loki.yaml, dev-docker/monitoring/config-dev/database.rules*.yml, dev-docker/traefik/dynamic/origin-pull.yml, dev-docker/traefik/dynamic/origin-cert.yml, dev-docker/traefik/plugins-local/**, dev-docker/traefik/origin-pull/**, scripts/edge/**, tools/k8s_render.py, tools/k8s_render_test.py, tools/k8s_render_traefik_test.py, tools/k8s_render_monitoring_test.py, tools/k8s_secrets.py, tools/k8s_secrets_test.py, dev-docker/monitoring/docker-compose.sys-monitor.yml, tools/k8s_deploy_test.py, tools/k8s_release.py, tools/k8s_release_test.py, tools/k8s_memfit.py, tools/k8s_memfit_test.py, tools/k8s_rehearse.py, tools/k8s_rehearse_test.py, scripts/k8s-rehearse.sh, scripts/k8s-add-node.sh, tools/k8s_manifest.py, tools/k8srender/**, k8s/**, scripts/prod.k8s.sh, dev-docker/compose/db-migrate.yml, txnet-backend/Dockerfile, txnet-backend/.dockerignore, dev-docker/traefik/Dockerfile, dev-docker/traefik/.dockerignore, scripts/move/**, scripts/bundle/**, scripts/moved-guard.sh, scripts/dev.compose.sh, scripts/prod.compose.sh, txnet-backend/prisma/seed-owner-password.js, txnet-backend/prisma/seed-platform-doors.js]
owns_tables: []
depends_on: [automation, i18n]
updated: 2026-10-25
---

# hosting

**Responsibility (one sentence):** how the services run and survive — the
Kubernetes (k3s, ADR-0147) and compose stacks, Postgres's backup, the whole-platform backup bundle, tuning and
connection pool, the log pipeline's bounds and format, healthchecks, and housekeeping of operational tables.
**Explicitly NOT responsible for:** uploaded files' backup (`object-storage`, ADR-0120), Redis key layout
(`redis-keyspace`), alert rules owned by a business unit (`billing.rules.yml`, …), what a service does once it is up.

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | building any OPS-1 row — rules H1…H23 are the spec |
| [contract.origin.md](contract.origin.md) | the origin answering only the approved edges: pull certificate, client address, firewall, private responses (EDGE-1-g, -h, -j) — rules O1…O11; what ArvanCloud does as the domestic edge (NIN-1-a); the approved-edge list and its ranges (NIN-1-b1, O8); the domestic edges on the same 443, known by their ranges (NIN-1-b4, O12); the domestic domain's records on Arvan, `edge_zone.py arvan` (NIN-1-d1, O14) |
| [contract.origin-cert.md](contract.origin-cert.md) | the origin certificate, never renewed online: Cloudflare's Origin CA on 443 for every edge, no Let's Encrypt; issued, sealed, served, its expiry alerted 30 days ahead (NIN-1-c) — rule O13 |
| [contract.kubernetes.md](contract.kubernetes.md) | production on k3s, rendered from compose, its monitoring, ports and memory (OPS-1-o-a … -r) — rules K1…K19 |
| [contract.secrets.md](contract.secrets.md) | the env and key files the render reads, sealed with SOPS + age, opened only in memory, rotated (OPS-1-o-j, -u, -w) — rules S1…S8 |
| [contract.release.md](contract.release.md) | a release: built and pushed off the k3s node, pulled with a sealed pull-only login, each image tagged by its source, a fresh database seeded, smoke-checked, set back whole on a failure or by `rollback [tag]` (OPS-1-o-m, -p, -x, -y) — rules R1…R13 |
| [contract.health.md](contract.health.md) | a healthcheck on a container that is not a Nest app: auth-handler, Traefik, the Next apps, guide-media, mailpit, the backup loops (OPS-1-aa) — rule H24 |
| [contract.bundle.md](contract.bundle.md) | the whole platform as one encrypted file: made nightly or now, shipped write-only to S3, restored here, elsewhere or into the cluster (OPS-1-ad, -o-k) — rules B1…B10 |
| [contract.nodes.md](contract.nodes.md) | a second k3s node: joined or removed by one command from the server, WireGuard between nodes, K13's peers, the preflight that refuses a server (OPS-1-o-q) — rule K17 |
| [contract.backup.md](contract.backup.md) | Postgres's second backup repository on S3 under object lock, and an S3 outage that never stops Postgres (OPS-1-o-o) — rule K15 |
| [open-questions.md](open-questions.md) | production's starting data (OPS-1-p), the standby server (OPS-1-y), the two doors and the backup bucket (ADR-0165) |

## Status

`active` since 2026-10-14. Built: EDGE-1-g, -h, -j, -k, -m (`contract.origin.md`); OPS-1-k, -l, -z (H12/H13,
`shared-core/src/lib/logging` in every Nest service, the gate, the queue); OPS-1-a (H1/H2, WAL archived,
`pgbackrest-repo.sh` → `conf.d/repo.conf`); -b (H3, `compose/pg-backup.yml`, shared socket); -c (H4, `pg-backup.sh
drill`, `pg_restore_drill.prom`); -f (H10, `main-db` `command:`, sizing in `operations/environments.md`); -d (H5,
`database.rules.yml` + `promtool` tests); -e (H6, restore runbook, rehearsed); -g (H9, C-41's check); -h (H7, `db-pool`:
PgBouncer 1.25.2, own user, tmpfs); -i (H8, every pooled URL on `db-pool`, 5 `LISTEN`s direct; 15 of 100 on dev); -j
(H11, `compose/logging.yml` on all 28 services, `loki.yaml` 30 days, loopback); -v (H21, `hosting.broker-redis` in
`database.rules.yml`, `redis-exporter`). -ac (H23, `scripts/move/`: a server move, `runbook-move-server.md`). -ad (B1–B9, `scripts/bundle/`). -o-a…-e, -o-g, -o-i, -o-j, -o-l, -o-m, -o-p, -o-u…-w (K2–K16, S1–S8, R1–R11: `tools/k8srender/`, `k8s/`, `scripts/prod.k8s.sh`, `scripts/edge/`). -o-o (K15, repo2). -o-k (B10, `--stack k8s`). -aa (H24).

## Changelog
| Date | Change |
|---|---|
| 2026-10-14 | **draft -> active** (OPS-1-ab): status caught up with code already shipped (the OPS-1 and EDGE-1 rows listed under Status); no contract change |
