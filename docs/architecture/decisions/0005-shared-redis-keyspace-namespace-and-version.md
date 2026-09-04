---
id: adr-0005
status: accepted
updated: 2026-09-04
---

# ADR 0005 — Shared Redis keyspace prefix `<namespace>:<version>:`

- **Status:** accepted
- **Date:** 2026-09-04 (documented; predates this doc)
- **Affects units:** redis-keyspace, identity, forward-auth

## Context

`auth-service` (Node) and `auth-handler` (Go) share one Redis. They must read the
same `session:*` keys, and dev/prod may share an instance. A bad migration or a
poisoned keyspace needs a cheap escape hatch.

## Decision

Every key both services touch is prefixed
`${REDIS_KEY_NAMESPACE}:${REDIS_KEYSPACE_VERSION}:` (default `txnet:auth:v1:`).
Node applies it via ioredis `keyPrefix`; Go assembles it in `config.go`
(`buildRedisKeyPrefix`, kept in sync by comment). Bumping
`REDIS_KEYSPACE_VERSION` (`v1` -> `v2`) abandons the entire keyspace at once —
old keys simply expire. Key names themselves are built only in
`redis.keys.ts` / `auth-handler` config, never hand-written elsewhere.

## Consequences

- Positive: safe multi-env sharing; one-line keyspace reset; no scan-and-delete.
- Negative / accepted cost: the two implementations of the prefix must stay
  byte-identical; a version bump logs everyone out (that is the point).
- Forecloses: per-service key namespaces (deliberately — they must overlap).

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Separate Redis per service | auth-handler could not see auth-service sessions |
| No version segment | no cheap way to abandon a corrupted keyspace |
| Redis logical DB number | not supported the same way across managed Redis |

## Revisit trigger

A third service needing the keyspace, or moving session state off Redis.
