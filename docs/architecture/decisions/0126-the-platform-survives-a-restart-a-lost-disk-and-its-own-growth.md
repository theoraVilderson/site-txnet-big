---
id: adr-0126
status: active
updated: 2026-10-06
---

# ADR 0126 — the platform survives a restart, a lost disk and its own growth

- **Status:** accepted (nothing built yet — rows OPS-1-a..y)
- **Date:** 2026-10-06
- **Affects units:** hosting (new), automation, i18n, bot-app, realtime, panel-web
- **Decision:** the user's, 2026-10-06 (D-62): "backlog all of these, written so
  that building them raises no question". Every choice below was settled by the
  agent on that instruction, each one the option that does not have to be
  rebuilt as tenants, services and servers are added. Any point can be reopened
  by the user; none is to be reopened by a building session.
- **Spec:** [hosting/contract.md](../../platform/hosting/contract.md) — the rules
  a row cites by number (H1…).

## Context

A review on 2026-10-06 measured the dev stack and read its configuration:

- **Postgres has no backup.** No `pg_dump`, no WAL archive (`archive_mode=off`).
  Uploaded files have one (ADR-0120); the ledger and the wallets do not.
- **89 of 100 Postgres connections were in use** with one copy of each service.
  Prisma's default pool is `cpus*2+1` (17 on this 8-core host) per client and
  no client sets `connection_limit`. A second replica of anything, or a host
  with more cores, is `too many clients`.
- **`automation.bot_execution_log` grew to 249,007 rows / 127 MB in 23 days**
  with no real users — 73% of the database — and nothing deletes from it.
  `automation.outbox_event` keeps every published row too.
- **Production logs are unbounded.** `scripts/prod.compose.sh` runs
  `docker-compose.main.yml` alone; only Redis and one frontend there set
  `max-size`, and the host's `daemon.json` sets no default. Loki runs its
  built-in config with no retention, its port published on the host.
- **Nest services log plain text**; the Go services already log JSON (`slog`).
- **A restart has five rough edges.** Every Node service and `auth-handler`
  block their boot on `locale-service` and fail when it is down. The tick publisher loses a
  minute when the schedule read fails. Bot updates queued during an outage are
  executed hours late. No Nest service has a container healthcheck, so Traefik
  routes to a booting process. The WebSocket gateway closes with `1001` and
  every panel reconnects inside ~0.6s.
- **Production orchestration is not built.** `swarm/docker-stack.yml` is 19
  lines; AGENTS.md and ADR-0022 already name Docker Swarm as production.

## Decision

1. **Postgres is backed up continuously with pgBackRest** (Alpine package
   2.58, verified on the mirror 2026-10-06). WAL is archived as it is written;
   a full backup weekly and a differential nightly. The repository is set by
   configuration, a local directory in dev and a target off the server in
   production, the same shape as ADR-0120. Chosen over WAL-G for its `verify`,
   its retention by full-backup count and its documented local-socket mode;
   over `pg_dump` because a nightly dump loses up to a day of payments.
2. **A restore is proven weekly, not assumed.** A drill restores the latest
   backup to a scratch directory, starts a throwaway Postgres on it and checks
   that the ledger's last row is inside the recovery window. A backup nobody
   has restored is a hope.
3. **Every pooled connection goes through PgBouncer in transaction mode**
   (Alpine package 1.25). Safe here because the code holds no session state:
   tenant binding is `set_config(..., true)` (`with-tenant.ts`), locks are
   `pg_advisory_xact_lock`, and no session `SET` exists (checked 2026-10-06).
   The three `LISTEN` holders, migrations, backups and the exporter stay on
   direct connections. Each client sets an explicit pool size, and the budget
   in contract H8 must fit under `max_connections` with headroom.
4. **Postgres is tuned by environment variables with stated defaults**, not
   left at `shared_buffers=128MB`.
5. **Every container's logs are rotated, Loki keeps 30 days, and Nest services
   log one JSON line per event** with the field names `slog` already uses, plus
   `service`, `requestId` and `tenantId`. `tenantId` is a JSON field, never a
   Loki label (one label value per tenant would exhaust Loki's index).
6. **Housekeeping is a Job (ADR-0027):** execution-log rows are kept 30 days
   (failed and partial 90), published outbox rows 7 days, deleted in batches.
   Not partitioning: ~11k rows a day is well inside what a batched delete
   handles, and partitioning would change the table's key.
7. **Production is Docker Swarm on one node**, every service `replicas: 1`
   with `update_config.order: start-first`. That is what makes a deploy
   zero-downtime: the new task must pass its healthcheck before the old one
   stops. Scaling a service past one replica is a later decision per service,
   not part of this one. `container_name` stays: Swarm ignores it.
8. **Every service has a container healthcheck**, an HTTP `/health` where it
   serves HTTP, and a heartbeat file where it does not (worker, metering).
9. **A service boots from its last saved translations** when
   `locale-service` is unreachable, and its Watch stream catches up when it
   returns. With no saved copy it fails as today. Both shared clients, Node
   and Go: `auth-handler` uses the Go one, and every request passes it.
10. **The tick publisher retries a window whose schedule read failed.**
11. **A bot update older than 10 minutes is not executed.** The user is told,
    once per chat, that the bot was briefly unavailable and to try again. A
    stale "buy" pressed hours ago must never run.
12. **A restarting gateway closes with `1012`, and the panel spreads its first
    reconnect over 0–10s** (full jitter), then backs off with full jitter.
13. **RabbitMQ, Redis and Postgres archiving are watched**: a broker alarm, a
    growing bot queue, Redis near its explicit `maxmemory`, a failing WAL
    archive and a stale backup each raise an alert. Redis keeps `noeviction`:
    its keys without a TTL are bounded caches (role permissions, tenant status,
    exchange readings — checked 2026-10-06), and evicting a session would sign
    a user out silently.
14. **A standby on a second server is planned, not built** (OPS-1-y, blocked on
    the server existing).

## Consequences

- Production gains three containers — `pg-backup`, `db-pool`,
  `redis-exporter` — and the Postgres image becomes our own
  (`dev-docker/postgres/`).
- A failing WAL archive keeps WAL on the Postgres disk until it succeeds. That
  is the correct failure (no data is dropped) and the reason H5 alerts on it
  within 15 minutes.
- Two replicas briefly exist during a `start-first` deploy. The tick publisher
  already accepts a duplicate tick (`tick.publisher.ts`); gateway-service holds
  sockets, not state, and the old task's sockets reconnect to the new one
  (point 12); every other service is stateless between requests.
- What the cheaper options would have cost: `pg_dump` loses a day of money;
  raising `max_connections` instead of pooling costs ~10 MB of RAM per
  connection and fails again at the next replica; deleting logs by hand is an
  outage the first time nobody does.

## Alternatives rejected

- **Managed Postgres.** No provider was named; the repository setting lets the
  backup target move without code.
- **Kubernetes.** One server and one operator; Swarm already reads the compose
  files this repo has.
- **Partitioning `bot_execution_log`.** See point 6.
