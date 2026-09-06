---
id: network
layer: domain
status: draft
version: 2
updated: 2026-09-06
---

# Contract — network

**DRAFT — schema only.** From `txnet-backend/prisma/domains/network.prisma`.

## TL;DR

A Config is one user's credential (`uuid` + protocol) on one Panel — the x-ui /
Xray server install. `tenantId` is denormalized onto `config` (first key of a
composite index) so a tenant's User panel can query its configs without a join.
`Panel.tenantId = null` = shared pool; set = dedicated to that tenant.

## Provides (intended)

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| provision config | userId, servicePlanId, panelId?, protocol | `config` (`active`) + Xray uuid pushed to the Panel API | sync + Panel API call | panel down, plan inactive |
| regenerate config | configId | new `uuid`, `regenerateUsedCount++` | sync | over `maxRegenerateCount` |
| set config status | configId, status, reason, actor | `config` + `config_action_log` row | sync | — |
| ingest traffic | panel -> {configId, up, down, at} | `traffic_raw_log` (partitioned) | async, high volume | — |
| nightly aggregate | date | `traffic_daily_aggregate` rows; drop old raw partition | async (cron) | — |
| add IP rule | cidr, ruleType, limit?, expiry? | `ip_access_rule` | sync | — |

## Emits (events)

None planned. Config status changes are expected to be pushed to the Panel API
by the provisioning service directly.

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| identity | `userId` owner of a config | provisioning blocked |
| catalog | `servicePlanId` for the config | provisioning blocked |
| tenant | `tenantId` denormalized onto panel/config; dedicated Panel pools | shared pool still usable |
| billing | `sub_account` draws down `config` byte caps | metering stops |

## Guarantees (intended)

- `config.uuid` is globally unique (the real Xray uuid).
- `traffic_raw_log` is monthly range-partitioned; old partitions are `DROP`ped
  after aggregation, never row-deleted.
- Layer-1 rate limiting is Redis-only and intentionally has no table; this unit
  is layer-2 (durable rules).
- `panelApiCredentials` is encrypted, never default-selected or logged.

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| model/table `Node` (`node`) | 2026-09-06 | removed in the same change | `Panel` (`panel`) — see `docs/GLOSSARY.md` banned words |

§8 normally forbids removing a shape in the change that replaces it. It was
removed outright here because the consumer list is empty: `source: []`, no
service reads the model, and no migration was ever committed.
