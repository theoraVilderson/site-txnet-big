---
id: arch-overview
status: active
updated: 2026-10-14
---

# Architecture overview

The platform as it runs on 2026-10-14. Which unit is built is
`MASTER_INDEX.md`'s `status` column, not this page; this page says how the
pieces fit. Each claim cites the ADR or contract that owns it — read that,
not this, before changing the thing.

## What the system does

TXNet is a multi-tenant, white-label reseller platform for VPN / digital
services. One **platform owner** operates the system; many **resellers**
(tenants) sell to end users under their own brand, domain, pricing, payment
gateway and Telegram/Bale bot. The platform bills tenants; end users pay their
own tenant through that tenant's own gateway — **tenant money never flows
through the platform** (ADR-0006).

## Runtime topology

```
internet -> Cloudflare -> Traefik "gateway-handler" (origin answers Cloudflare only: hosting/contract.origin.md)
   |-- ForwardAuth (my-auth / my-auth-optional) -> auth-handler (Go): JWT + Redis session + RBAC -> X-User-* headers
   |
   |-> site-pwa (Next.js)       panel.<domain> + every reseller host   panel-web
   |-> coinsite (Next.js)       <domain>, www.<domain>                 marketing-web
   |-> auth-service             /api/auth                              auth-api, identity
   |-> tenant-service           /api/tenants, /api/tenant-packages, /api/guides,
   |                            /api/public/tenant, /api/files, /api/branding    tenant, guide
   |-> billing-service          /api/billing (+ deposit callback), /api/catalog  billing, catalog, entitlement
   |-> currency-service         /api/currency                          currency
   |-> notification-service     /api/notifications                     notification
   |-> support-service          /api/support                           support
   |-> ai-service               /api/ai (one CPU, capped)              ai (ADR-0109)
   |-> bot-service              api.<domain>/api/bot (webhooks)        bot-app, messenger
   |-> gateway-service          /realtime (WebSocket)                  realtime (ADR-0030)
   |-> sub-service (Go)         /sub/{token}                           sub-api (ADR-0082)
   |-> guide-media (nginx)      /api/public/media/ (read-only volume)  object-storage (ADR-0118)

no HTTP surface:  worker-service (Nest, ADR-0027) · metering-service (Nest, ADR-0077)
                  network-service (Go, the VPN-panel collector, ADR-0071)
locale-service (Go gRPC) <- every service boots from a snapshot, then Watch; disk cache if it is down (H17)
```

Every Nest service lives in the `txnet-backend/` Nx workspace and shares
`shared-core` (logging, health, Redis keys, tenant context, i18n, rate limit).
The Go services are `go.work` modules. `docs/CODE-LAYOUT.md` lists the roots.

## Data and messaging

```
services --pooled--> db-pool (PgBouncer, transaction mode) --> main-db (Postgres 18, multiSchema)
         --direct--> main-db, only for the LISTEN connections (H8)
         ---------> memory-data (Redis 8: sessions, OTP, rate limits, caches, realtime pub/sub)
         ---------> rabbitmq (automation exchange: ticks, outbox.*, bot.update.<slot>, network.usage.#)
```

- **Postgres.** One database, one schema per business domain
  (`txnet-backend/prisma/domains/*.prisma`, ADR-0001). Login roles:
  `txnet_app` (row-level security enforced), `txnet_cross_tenant` (an explicit
  all-tenants policy, for collectors and sweeps), `txnet_ai_reader`. No role
  holds `BYPASSRLS` (`tenant-context`, ADR-0024).
- **Redis.** Every key is built through `RedisKeys` (`redis-keyspace`, C-03);
  `noeviction` under a `maxmemory` ceiling (H21).
- **RabbitMQ is the background runtime.** Jobs are consumers in
  `worker-service`, never an in-process scheduler in a serving replica
  (ADR-0027). The tick publisher, the dead-letter path and the job registry are
  `automation/contract.worker.md`.

## Cross-domain events: the outbox

A service that changes state another domain must react to inserts an
`automation.outbox_event` row **in the same transaction** as the change.
`OutboxRelayJob` publishes unpublished rows to `outbox.<type>`, `mandatory`,
so an event no queue binds stays unpublished and alerts (ADR-0021,
`automation/contract.outbox.md`). Every type now has a bound queue: consumers
in `worker-service` turn a confirmed payment into a delivered Grant, a notice,
a commission, a tenant renewal — each a call to the owning service's
`/internal/*` route over `X-Service-Token`.

Work a page shows reaches it over the socket: an outbox event in
`LIVE_PUSH_FIELDS` (or an `EventNotice`) is published by `worker-service` to
Redis `realtime:<channel>`, `gateway-service` delivers it, and the page
re-reads with `useLiveReread` — no page polls (ADR-0121, C-14).

Other queued paths: the bot webhook answers 200 after publishing to
`bot.update.<slot>` and `worker-service` dispatches the flow back to
`bot-service` (F-067-b); `network-service` publishes collection passes to
`network.usage.#`, which `metering-service` turns into usage. Runtime edges
are tabled in `dependency-graph.md`.

## Boundaries

- **Tenancy.** A request's tenant is ambient (`tenant-context`) and every
  scoped query derives `tenantId` from it; Postgres RLS refuses a query that
  names none (ADR-0024). Cross-tenant work runs only on the cross-tenant pool.
- **Trust.** Everything from the browser is untrusted. Traefik strips
  client-sent `X-User-*` / `X-Tenant-*` / `X-Role-*`; only `auth-handler` sets
  them. Service-to-service calls carry `X-Service-Token`. The origin accepts
  only Cloudflare's pull certificate (`hosting/contract.origin.md`).
- **Transactions.** A money mutation is one Postgres transaction appending a
  ledger row and moving the cached balance (ADR-0002); the events it causes
  commit with it (outbox). Delivery after commit is at-least-once, so every
  consumer is idempotent (C-29). Realtime push is at-most-once by design.
- **Process.** A job never runs inside a request-serving replica (ADR-0027);
  the collector and `/sub` are separate deployables so one cannot stall the
  other (ADR-0071, ADR-0082).

## Running and surviving (unit `hosting`, ADR-0126)

- **Stacks.** Dev and today's production are `docker compose`:
  `dev-docker/docker-compose.main.yml` includes one file per service under
  `dev-docker/compose/`; `scripts/dev.compose.sh` / `scripts/prod.compose.sh`
  run it. Monitoring is its own stack
  (`dev-docker/monitoring/docker-compose.sys-monitor.yml`: Prometheus,
  Alertmanager, Grafana, Loki, Promtail, exporters).
- **Swarm is not yet the deploy path.** `swarm/docker-stack.yml` is a stub;
  the complete stack with start-first rolling updates is OPS-1-o (H16).
- **Backup.** WAL is archived continuously by pgBackRest; `pg-backup` takes a
  weekly full and nightly differentials, and a restore drill runs every Sunday
  (H1–H6). Uploaded files: `object-backup` (restic, nightly, ADR-0120). A
  standby server is OPS-1-y, blocked on the second server (H22).
- **Health and logs.** Every Nest service has a healthcheck (`/health` runs
  `SELECT 1` on its pool; a heartbeat file for the no-HTTP ones, H15). Logs are
  JSON with a request id, size-rotated, and Loki keeps them bounded (H11–H13).
- **Restarts.** A gateway restart closes sockets with `1012` and panels
  reconnect with jitter (H20); a bot update older than 10 minutes is not run
  (H19).

## Non-goals

- The platform does not custody or route tenant end-user funds.
- No per-language configuration: clients load every language `locale-service`
  advertises.
- No service owns another domain's tables; a cross-domain write is an outbox
  event or an `/internal/*` call, except where an ADR names the exception
  (`tenant` -> `billing` ledger, ADR-0061).
