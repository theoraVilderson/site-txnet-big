---
id: network
layer: domain
updated: 2026-09-21
---

# Data model — network

Source of truth: `txnet-backend/prisma/domains/network.prisma` (Postgres schema
`network`).

## Tables owned
| Table | Purpose | Tenant-scoped? | Retention |
|---|---|---|---|
| panel | one remote management install, and its **declaration** — driver family, counter semantics, transport, capabilities, review verdict, health and request budget | `tenantId` nullable | permanent |
| config | user credential on a panel (uuid + protocol + status) | `tenantId` NOT NULL (denormalized) | soft state via `status` |
| config_action_log | who did what to a config | via config | permanent |
| traffic_raw_log | per-interval up/down bytes; **monthly partitioned**, BigInt PK | via config | drop old partitions |
| traffic_daily_aggregate | nightly rollup per (user, config, date) | via config | long |
| ip_access_rule | durable block / allow / custom-rate-limit by IP or CIDR | no | expires if `expiresAt` set |

## The Panel declaration (F-027-a, ADR-0074)

A Panel does not merely describe itself. `driverType` (13 families),
`counterSemantics` (`cumulative | session | reset_on_read`) and `transport`
(`pull | push`) select the arithmetic and the direction of the conversation,
and are NOT NULL with no default: a row that never answered the acceptance
questionnaire cannot exist. `capabilities` holds the questionnaire itself as
JSONB — validated and versioned on write, because the shape is not the
database's to hold — and `reviewState` carries its verdict, which is where an
unsuitable panel is refused (before it has users, not at billing time).

`panelState` (was `status`) separates `throttled_or_blocked` from `down`: a
`429` or `403` is a panel answering and refusing us, and `blockedSince` is the
clock on it. `maxRequestsPerMinute`, `maxLineRateBps` and
`observedWriteLatencyMs` are what size a ceiling in seconds rather than bytes
(ADR-0072); `lastHealthyAt` and `lastSuccessfulCollectionAt` are what an
external watchdog reads, so a stalled collector is visible before a wrong
number is.

Five of these are CHECK constraints rather than service rules, because every
one of them is a silent wrong number if it is only a convention:
`panel_ownership_matches_tenant`, `panel_pull_has_base_url`,
`panel_capabilities_object`, `panel_request_budget_positive` and
`panel_blocked_since_needs_state`.

## Relationships crossing unit boundaries
| This table | -> | Other unit's table | Why it is allowed |
|---|---|---|---|
| config.userId | -> | identity.user.id | a config belongs to a user |
| config.grantId | -> | entitlement.grant.id | the Grant it was provisioned for (F-026-b; was `servicePlanId`) |
| config.tenantId, panel.tenantId | -> | tenant.tenant.id | dedicated pools / per-tenant scoping |
| config (referenced) | <- | billing.sub_account.configId | sub-account funds a config |

## Access rules

A tenant's User panel reads `config` filtered by `tenantId` (composite index leads with
`tenantId`). Traffic tables are written by an ingestion path, read by reporting.

## Migration notes

`20260921000100_panel_declares_its_driver` adds the declaration, drops
`panelType` with its enum, renames `PanelStatus` -> `PanelState` and widens
`ConfigProtocol` from the four Xray protocols to nine (adding `hysteria2`,
`tuic`, `wireguard`, `openvpn`, `pppoe`). Both enums are dropped and recreated
rather than altered — a value added by `ALTER TYPE` cannot be used in the
transaction that added it, and `prisma migrate` runs a file as one. It is
destructive, and asserts both tables are empty before it starts.

Native monthly partitioning on `traffic_raw_log` (and BRIN index on
`recordedAt`), plus RLS, are "section 99" manual SQL — **not applied**. Prisma
cannot express partitioning; the model must be created by hand-written migration.
