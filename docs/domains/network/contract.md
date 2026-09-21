---
id: network
layer: domain
status: draft
version: 3
updated: 2026-09-21
---

# Contract — network

**DRAFT — the schema plus a service that does not serve it yet.** The shapes
below are from `txnet-backend/prisma/domains/network.prisma`; none of the
operations exist. What exists is the process that will hold them:
`network-service/`, a Go deployable (ADR-0071, F-027-h).

## TL;DR

A Config is one user's credential (`uuid` + protocol) on one Panel — the x-ui /
Xray server install. `tenantId` is denormalized onto `config` (first key of a
composite index) so a tenant's User panel can query its configs without a join.
`Panel.tenantId = null` = shared pool; set = dedicated to that tenant, and
`ownershipType` says the same thing where the reader does not carry RLS.

A Panel also **declares** how it is driven and how it counts (`driverType`,
`counterSemantics`, `transport`, `capabilities`) — see `data-model.md`. Those
answers select behaviour: three delta arithmetics behind one normaliser, and a
panel refused at registration rather than at billing time (ADR-0074).

## The service (F-027-h)

`network-service/` is a Go module and a `go.work` member. It connects with one
`pgx` pool as a member of `txnet_cross_tenant` — the collector spans every
tenant, so it has no per-tenant scope to fall back on — and it refuses to boot
against a connection that is not a member of that role.

Prisma owns the schema and this service writes no migrations, so at boot it
reads `information_schema` and refuses to start naming every `network.*` column
it depends on that the database does not have
(`network-service/internal/db/schema.go`, `RequiredColumns`). A row that starts
reading a new column adds it to that manifest in the same change.

**Nothing here answers a user request.** Its only HTTP surface is `/health`
(200, or 503 when the database is unreachable), for the container and the
watchdog; it is not routed through the gateway and holds no gateway route. That
is a consequence of the cross-tenant role, not a preference.

## Provides (intended)

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| provision config | userId, grantId, panelId?, protocol | `config` (`active`) + Xray uuid pushed to the Panel API | sync + Panel API call | panel down, Grant not active |
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
| entitlement | the `grant` a config is provisioned for — its status, quotas and `panelGroupId` via its variant (ADR-0049; F-027) | provisioning blocked |
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
| `Panel.panelType` + enum `PanelType` | 2026-09-21 | removed in the same change | `Panel.driverType` + enum `DriverType` (13 families) |
| `Panel.status` + enum `PanelStatus` | 2026-09-21 | removed in the same change | `Panel.panelState` + enum `PanelState`, one value wider |

§8 normally forbids removing a shape in the change that replaces it. All three
were removed outright because the consumer list is empty: no service reads the
model, and `network.panel` has never held a row —
`20260921000100_panel_declares_its_driver` asserts that before it starts. The
`Node` removal additionally had no committed migration.
