---
id: adr-0083
status: active
updated: 2026-09-24
---

# ADR 0083 — `/sub`'s cache is invalidated by Postgres notifications, judged on Redis's clock

- **Status:** accepted
- **Date:** 2026-09-24
- **Affects units:** sub-api, redis-keyspace, network, tenant, entitlement

## Context

Catalog §7.5 serves `/sub` from a cached render (C-07's key) and invalidates
it **explicitly**, not by TTL. What changes a render is written by three
processes in two languages: network-service (Go) writes a panel's state and a
config's captured lines, tenant-service (TypeScript) writes domains, and
billing-service (TypeScript) writes the Grant. Rows are also written by hand.
network-service has no Redis connection at all.

C-07's key is `(grantId, healthyPanelSetHash, activeDomainSetHash, format)`.
A request knows none of the first three before it reads Postgres, so the key
cannot be looked up as written without the reads the cache exists to skip.

## Decision

1. **Postgres triggers are the writer that tells.** One migration puts an
   `AFTER` trigger on `network.panel` (`panelState`), `network.config` (the
   columns a render reads), `entitlement.grant` (status, token hash, tenant)
   and `tenant.tenant_domain` (the routing columns). Each calls
   `pg_notify('sub_invalidate', {kind, id})` with kind `panel`, `grant` or
   `tenant`, only when one of those columns actually changed. No application
   writer needs to remember anything (user, 2026-09-24).
2. **`sub-service` listens and stamps.** It holds one `LISTEN` connection and
   writes the **Redis server's time** into `sub:changed:<kind>:<id>` for each
   notification. On every (re)connect it stamps `sub:changed:all`, because a
   notification sent while nobody listened is lost.
3. **An entry is judged on read.** The Redis key is what a request knows
   (token hash, format, host). The entry records the Redis time taken before
   its first Postgres read, and the stamps it depends on: `all`, its Grant,
   its tenant, and every panel it has a config on. It is served only while
   every one of those stamps is older. That is C-07's key with the three
   hashes replaced by what they stand for.
4. **The cache is used only while this process's listener is live.** Redis
   down or listener down means render from Postgres. It is never a 5xx.

## Consequences

- Positive: a write committed during a render is heard after the render
  began, so the entry that render stores is already outdated. There is no
  race window. One clock (Redis's) is compared, never two replicas'.
- Positive: a new writer, in any language or by hand, invalidates without code.
- Positive: token rotation (F-113-d) already outdates the old token's entry
  through the Grant trigger.
- Negative / accepted cost: a hit is two Redis round trips (`GET`, `MGET`),
  and a miss costs one more (`TIME`) plus the `SET`.
- Negative / accepted cost: a stamp outlives the entries it outdates
  (2 × TTL + 1 min), one small key per changed id.
- A trigger on another unit's table is schema that unit carries. Its columns
  are named in the migration, and renaming one breaks the migration loudly.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Each writer INCRs a Redis generation in its own code | every future writer must remember, and forgetting is silent: a dead link served until the TTL. network-service would need a Redis client only for this |
| TTL only | contradicts §7.5, and a panel that went down stays in the body for a full TTL |
| Hashes in the key, computed per request | needs the Postgres reads the cache exists to skip |
| Generation counters read after the render | a change committed between the read and the counter read is lost. Taking the time before the first read closes that gap |

## Revisit trigger

A render that depends on a row none of the four triggers watches, such as
F-113-e's tenant status or F-609's usage bytes. Add a trigger kind for it in
the same row that starts reading it.
