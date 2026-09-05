---
id: dependency-graph
status: active
updated: 2026-09-05
---

# Dependency graph

Read this before any change: it defines **blast radius**.

## Generated (source of truth)

No static graph generator is wired up. For the Node backend, `npx nx graph`
(in `txnet-backend/`) shows project edges. Go modules: `go.work` at repo root +
`replace` directives in each `go.mod`. This section should be replaced with a
generated artifact if/when CI produces one.

## Runtime edges — what `depends_on` cannot see

A queue, a webhook, a cron job and a domain event move control between units
without either one importing the other. `depends_on` is blind to them, so a walk
(§3c) that follows only static edges misses an entire class of bug — confidently.

These are **not** merged into `depends_on`. A runtime edge answers **"what runs
after me"** (a debugging question); `depends_on` answers **"who do I call"** (a
contract question, §8 blast radius).

`tools/where.py --walk` reads this table by heading and by the four column
names, and `from`/`to` must be **unit ids** from `MASTER_INDEX.md` — not service
or container names. Add a row the first time a walk needs it.

| from | to | via | why |
|---|---|---|---|
| auth-api | i18n | gRPC GetSnapshot + Watch (async reload) | translations change under a running auth-service without a redeploy |
| forward-auth | i18n | gRPC GetSnapshot + Watch (async reload) | same snapshot stream; a stale gateway serves stale error text |
| panel-web | i18n | gRPC GetSnapshot at SSR boot | panel renders server-side with a snapshot it fetched, not with live calls |
| auth-api | redis-keyspace | Redis writes: session, OTP, rate-limit keys | the session exists only in Redis; nothing in Postgres records it |
| forward-auth | redis-keyspace | Redis reads: session-active check | revocation is a Redis delete the gateway notices on the next request |
| forward-auth | auth-api | Traefik ForwardAuth `/validate` -> identity headers | the gateway runs *before* the API and rewrites the request it receives |
| panel-web | auth-api | HTTP proxy `/api/auth/*` (cookies rewritten in the proxy) | a cookie can be correct at the API and lost in the proxy hop |

## Manual notes

- `auth-api` and `forward-auth` share one Redis key prefix by env convention
  (`redis-keyspace`). A prefix or version mismatch is invisible to both: the
  gateway simply never finds the session the API wrote. See ADR-0005.
- `locale-service` boot dependency is hard: `auth-api` and `forward-auth` refuse
  to start without a first snapshot. A "service won't boot" symptom starts at
  `i18n`, not at the service that failed.

## Consumer lookup

Consumers of unit X = every unit listing `X` in its front-matter `depends_on`.
Do not maintain a second hand-written list; derive it (or run
`python tools/docs-check.py`, which prints the reverse map).
