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
| config | user credential on a panel (uuid + protocol + status), and its **desired state** — presence, enablement, drift verdict and ceiling | `tenantId` NOT NULL (denormalized) | soft state via `status`; the row outlives its remote client |
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

## The Config's desired state (F-027-b, ADR-0072/0075)

A Config says what it is *supposed* to be, and the convergence loop drives the
panel towards that. `desiredEnabled` and `desiredRemote` are state, never
queued commands: the loop compares the desired state **as it is now**, so a
top-up arriving during a purge rebuilds the client rather than racing the
delete. `enforcementState` (`pending | partial | complete`) is how far it got —
`partial` exists because a purge half-applied across five panels is neither
pending nor done, and a Grant reports `purged` only when every config is
`complete`.

`remoteId`, `claimTag` and `uuid` are the three matching keys, tried in that
order (F-027-aa). The tag is ours and global: without it a rename on the panel
orphans the usage and we cut off a user whose config still works. `remoteId`
is unique per panel, and is the thing a purge clears — **the row is never
deleted** (ADR-0075), because desired state is what makes a rebuild a button.

`allocatedCeilingBytes` and `appliedCeilingBytes` are two columns on purpose
(ADR-0072): the first is what the allocator decided, the second what the panel
confirmed, and the gap is the loop's remaining work — what the panel UI shows
as `in queue`. Collapsed into one, the system believes a ceiling it never
wrote, which is free traffic at the far end of it and nothing red anywhere.
`observedRateBps` sizes the horizon in seconds rather than bytes (F-027-u);
`driftState` and `driftRepairCount` carry the verdict and the anti-flap stop
(`contested` after two repairs, F-027-ab). `credentialGroupId` groups the
configs issued together over one shared quota (§4.6).

Five CHECK constraints, for the same reason the Panel has its five:
`config_ceiling_bytes_not_negative`, `config_observed_rate_not_negative`,
`config_drift_repairs_not_negative`, `config_applied_ceiling_needs_time` (the
clock on the write, as `blockedSince` is the clock on a ban) and
`config_purged_has_no_remote_id`.

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

`20260921000200_config_carries_its_desired_state` adds the desired state
above. It is additive — every column nullable or defaulted — and adds a unique
index on `(panelId, remoteId)` plus scan indexes on `(panelId,
enforcementState)` and `credentialGroupId`.

Native monthly partitioning on `traffic_raw_log` (and BRIN index on
`recordedAt`), plus RLS, are "section 99" manual SQL — **not applied**. Prisma
cannot express partitioning; the model must be created by hand-written migration.
