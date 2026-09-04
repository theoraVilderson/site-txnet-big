# Project rules for AI agents

**Before any task, read `docs/00-PROTOCOL.md` and follow it.** It defines the
authority order, the tiered read protocol (token budget), and the modes:
BOOTSTRAP / EXTEND / IMPLEMENT / AUDIT / NEXT (§6b, delivery loop) /
RECONCILE (§6c, sync the backlog to existing code) / INGEST (§6d, feature
catalog -> backlog).

Start every task with `docs/MASTER_INDEX.md` (+ `docs/BACKLOG.md` for MODE: NEXT).
Never read the whole `docs/` tree.

## The feature catalog — read this part twice

`docs/features/App-Features.md` is the product spec: 1894 lines, 169 features.

- **Never open it.** Not with Read, not with grep, not "just to check".
- A backlog row's `spec ref` is a feature **id**. Resolve it with
  `python3 tools/spec.py <F-id>` — that prints exactly the block you need.
- `docs/features/MANIFEST.md` is the only index you may scan.
- Never write a line number into any doc. Ids are the only stable address.
- Never renumber a catalog id. It is cited by backlog rows, commits and ADRs.
- `docs/FEATURES-FORMAT.md` is the contract the catalog satisfies — fixed file.

Opening the catalog is the single most expensive mistake available in this repo.

## What this repo is

TXNet — a multi-tenant, white-label reseller platform for VPN/digital services.
One platform owner + many resellers (tenants), each with their own branding,
domain, pricing, payment gateway and bot. See `docs/architecture/overview.md`.

The repo is a polyglot monorepo:

- `txnet-backend/` — Nx workspace, NestJS services (`auth-service` live,
  `billing-service` scaffold) + the Prisma schema (`prisma/domains/*.prisma`,
  Postgres `multiSchema`, one schema per business domain).
- `auth-handler/` — Go Traefik ForwardAuth gateway (JWT + Redis session + RBAC).
- `i18n-platform/` — `locale-service` (Go gRPC, source of truth for every
  translation) + one shared Go client and one shared Node client.
- `locales/` — the translation content `locale-service` serves.
- `site-pwa/` — Next.js user panel. `coinsite/` — Next.js landing site (skeleton).
- `dev-docker/`, `swarm/`, `scripts/` — Traefik + Postgres + Redis + RabbitMQ +
  monitoring; `docker compose` for dev, Docker Swarm for prod.

Most Prisma domains are **schema only** — no service implements them yet. Those
units are `status: draft` with `source: []`. Do not describe unbuilt behaviour as
if it exists.

## Project-specific additions (safe to edit; the protocol file is not)

- Language: technical docs, code, commit messages, logs -> English. Persian
  inline comments already in the code may stay.
- Commits: conventional commits (`feat(identity): ...`). Scope = unit `id`.
- Money: base-currency `Decimal` only, never a second currency column; balances
  are ledger-derived, never written directly (see ADR-0002).
- Redis keys: build them through `redis.keys.ts` / `auth-handler` config only;
  every key is prefixed `${REDIS_KEY_NAMESPACE}:${REDIS_KEYSPACE_VERSION}:`
  (see `docs/platform/redis-keyspace/`).
- Before declaring work done, all three must pass:
  `python3 tools/docs-check.py`, `python3 tools/backlog.py`,
  `python3 tools/features-scan.py --check`.
- Commits reference the catalog id in the body: `spec: F-105`.
- `docs/BACKLOG.md` + `docs/MASTER_INDEX.md` are the complete resume state. A fresh
  session should need nothing else to continue.
- Delivery loop: MODE: INGEST pulls **one area** of the catalog into the backlog
  the day you start building it (`python3 tools/spec.py --todo` shows what is
  left); `/next` (MODE: NEXT) then ships one backlog item per session.
  `/reconcile` (MODE: RECONCILE) rebuilds the backlog from existing code — it
  has already been run once.
- Never ingest the whole catalog at once. An area you are not building costs
  nothing; ingesting it early fills the backlog with rows nobody can start.
