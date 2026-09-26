---
id: network
layer: domain
updated: 2026-09-26
---

# Data model — network

Source of truth: `txnet-backend/prisma/domains/network.prisma` (Postgres schema
`network`).

## Tables owned
| Table | Purpose | Tenant-scoped? | Retention |
|---|---|---|---|
| panel | one remote management install, and its **declaration** — driver family, counter semantics, transport, capabilities, review verdict and why a connection test gave none (`connectionTest*`, [contract.registration.md](contract.registration.md)), health and request budget; `retiredAt` = archived (invariant 49); `ovpnProfile` = a User Manager router's shared `.ovpn` ([contract.links.md](contract.links.md) rule 9) | `tenantId` nullable | permanent; one with no history may be deleted (F-027-bz) |
| config | user credential on a panel (uuid + protocol + status), and its **desired state** — presence, enablement, drift verdict and ceiling | `tenantId` NOT NULL (denormalized) | soft state via `status` — `retired` is deleted or moved away, CHECK `config_retired_is_absent` (F-027-z); the row outlives its remote client |
| config_action_log | who did what to a config | via config | permanent |
| traffic_raw_log | per-interval up/down bytes; **monthly partitioned** on `recordedAt`, PK `(id, recordedAt)` | `tenantId` NOT NULL (denormalized) | `DROP PARTITION` by the month |
| traffic_daily_aggregate | nightly rollup, one row per `(configId, date)` | via config | long |
| ip_access_rule | durable block / allow / custom-rate-limit by IP or CIDR | no | expires if `expiresAt` set |
| config_counter_state | the collector's memory of one config's raw counter, and the semantics it was read under | via config | one row per config, forever |
| usage_delta_seen | every applied delta, keyed by the delta's own id | via config | swept at 48h |
| usage_delta_quarantine | a measured figure we do not believe | via config (nullable) | until released or written off, then audit |
| usage_hold | measured bytes we believe and cannot bill yet | via config | same |
| panel_drift_event | a drift verdict over a whole panel's population | via panel | permanent |
| unattributed_usage | usage against a remote client that matches no config | via panel | one row per remote client |
| radius_session | one RADIUS accounting session, its high-water bytes and how it closed | via config (nullable) / panel | permanent |
| panel_group | where a variant's Grants are provisioned: `strategy`, `minHealthyPanels`, `subscriptionTtlSeconds` ([contract.groups.md](contract.groups.md)) | `tenantId` nullable (null = platform), shared-read | permanent |
| panel_group_member | a panel in a group, once: `priority`, `weight`, `role` (`primary \| replica \| drain`), `drainingSince` | `tenantId` = its group's (trigger), shared-read | removed after draining |
| panel_inbound | a panel's inbound as last read (`goneAt` once unlisted), and the admin's pick `sold` / `maxClients`; with `panel.inboundPlacement`, `panel.maxClients`, `config.inboundRemoteId` ([contract.inbounds.md](contract.inbounds.md)) | `tenantId` = its panel's (trigger), shared-read | with its panel |

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

Six are CHECKs, as each is a silent wrong number if only a convention: `panel_ownership_matches_tenant`, `panel_pull_has_base_url`,
`panel_capabilities_object`, `panel_request_budget_positive`,
`panel_blocked_since_needs_state` and `panel_radius_secret_is_push_only`: a
push panel's NAS secret is a vault reference of its own (F-027-az).

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
`observedRateBps` sizes the horizon (F-027-u); `driftState`/`driftRepairCount`/
`driftRepairedAt` are the verdict and 24 h stop (F-027-ab); `credentialGroupId`
is one group placement, one row per panel (`config_group_panel_once`, F-027-bl) but a drained (`drainedAt`) one, F-027-bp; `walletBackedCeilingBytes` ≥ allocation is a shutdown's
ceiling (ADR-0078); `linkLines` is what `/sub` serves (contract.links.md); `trafficUnlimited` is its Grant's, copied at create, and such a row holds no ceiling (`config_unlimited_has_no_ceiling`, F-111-r). `userLabel` is the buyer's name for it, display only, never sent to a panel (`config_user_label_shape`: trimmed, 1..40; F-307-f, ADR-0089).

Five CHECK constraints, for the same reason the Panel has its five:
`config_ceiling_bytes_not_negative`, `config_observed_rate_not_negative`,
`config_drift_repairs_not_negative`, `config_applied_ceiling_needs_time` (the
clock on the write, as `blockedSince` is the clock on a ban) and
`config_purged_has_no_remote_id`.

## Where a measured byte waits (F-027-c, ADR-0074)

Six tables, one promise: a measured byte is **billed, held or quarantined**,
and never silently dropped.

`config_counter_state` is the cursor. It holds the last *raw* figures, not a
total, which is what makes a counter going backward a reset rather than
negative usage; `lifetime*Bytes` is the total across resets. It also stores the
`counterSemantics` the cursor was computed under, because a panel re-declared
from `cumulative` to `session` invalidates it and a cursor that does not say
what it meant cannot be invalidated. `lastPublishedAt` is written only after a
successful publish (F-027-n), so a crash between read and publish re-reads
rather than loses.

`usage_delta_seen` makes the delta's **own id the primary key**. The insert is
the deduplication: applying a redelivered message is a constraint violation the
consumer absorbs, not a second charge. `seenAt` is indexed for the 48h sweep
and for nothing else.

`usage_delta_quarantine` holds a figure we do not believe — the plausibility
cap, a reset whose pre-reset bytes were never measured, a clock going
backward. `usage_hold` holds one we *do* believe but a declared incapacity
stops us billing: a NAS with no Gigawords past 4 GB, a session with no `Stop`.
Both end `released` or `written_off` and there is no `dropped`, which is what
makes the holds queue (F-027-ad) the visible face of the promise — while
anything sits in it, nobody can claim the system lost a byte in silence. Note
this is not ADR-0072's rejected *wallet* hold: no money is reserved, only
bytes are parked.

`panel_drift_event` is the panel-wide stop (F-027-ab): a backup restore reads
as thousands of individually plausible resets, so the population is the unit of
judgement. Both counts are stored rather than a ratio, and `collectionHalted`
defaults to true because carrying on is ~$16k of wrong charges in a minute.

`unattributed_usage` is the byte we measured and could not place. It exists so
the bytes cannot be dropped for want of a row, and it is **one row per remote
client**, accumulated — an orphan is re-observed every pass, so per-reading
rows would be a row a minute per unclaimed client. What happens to the client
itself is the panel's `orphanPolicy`, not this table's.

## A session is closed, never abandoned (F-027-d, ADR-0074)

`radius_session` is the one table a push source needs and a pull source does
not. A pull panel hands us a running total and `config_counter_state` remembers
where the counter was; a NAS hands us packets about a *session*, and the
session is the unit of everything that can go wrong with one.

`Acct-Input-Octets` is 32 bits and wraps at 4 GB, with the high bits in
`Acct-Input-Gigawords`. A NAS that omits Gigawords loses 4 GB per wrap in
silence, and that loss is indistinguishable from a quiet user unless we wrote
down whether the attribute was ever there — which is what `gigawordsSeen` is
for: past the first wrap without it, the bytes become a `gigawords_missing`
hold rather than a guess. Every byte column is `BIGINT`, because the
reconstructed total in 32 bits would be the same trap in our own storage.

A session counter only rises, so `highWaterInBytes` / `highWaterOutBytes` are a
high water mark: a lower reading is a NAS restart, never negative usage.
`publishedInBytes` / `publishedOutBytes` are how much of that mark has already
left as a delta, and they are bounded by it — a session whose `Stop` never
arrives closes at its last observed figure and is never extrapolated past it,
so the extrapolation must not be writable. `closeReason` says which of five
ways it ended: only `acct_stop` is the NAS telling us, and the other four are
us deciding, which is a materially weaker figure and has to stay legible as
one.

The identity is `(nasId, acctSessionId)`, because `Acct-Session-Id` is unique
only within the NAS that issued it — two NASes numbering from 1 would otherwise
collide and one user's traffic would land on another's session. `configId` is
nullable and `remoteIdentifier` is not: an unplaced session still has a row, so
the bytes are never dropped for want of one.

`internal/radius` reads and writes it (F-027-af). The table landed first so
one migration series covers the whole network schema.

## Traffic goes by the month (F-027-e)

`traffic_raw_log` is the highest-volume table in the platform, and its
retention was written as `DROP PARTITION` from the first day — invariant 2 —
with nothing behind the sentence until now. It is partitioned by range on
`recordedAt`, one partition per month: the nightly rollup computes
`traffic_daily_aggregate`, and the month's raw rows then go in one catalogue
operation rather than a row-wise `DELETE` competing with the collection loop
for the same pages.

Three consequences are not cosmetic. The primary key is `(id, recordedAt)`,
because Postgres requires the partition key in every unique constraint — a
bare `BIGSERIAL` id is the one shape this table cannot have, and
`network.prisma` has to agree or the next `migrate diff` proposes undoing the
partitioning. `recordedAt` is indexed with **BRIN**: the table is append-only,
so its physical order already follows the column, and the summary costs a
fraction of the B-tree's per-insert price at this volume. `tenantId` is
denormalized as it is on `config` (invariant 6), because the reporting read is
per tenant and reaching the tenant through `config` is a join against this
table.

There is **no `DEFAULT` partition**, deliberately: it is the one partition that
can never be dropped, so rows for an uncreated month would outlive the
retention rule in silence. A missing month raises on insert instead — loud, and
the delta behind it goes to quarantine rather than nowhere (invariant 18). Six
months ship with the migration and
`network.ensure_traffic_raw_log_partition(date)` rolls the rest forward,
idempotent so the nightly job calls it blindly. A table with no partition for
next month stops accepting traffic at midnight on the 1st, so that call is part
of the rollup job, not setup.

`traffic_daily_aggregate` gains the unique key it never had, `(configId,
date)`. Without it a cron rerun — a retry, an operator re-running last night —
wrote a second row for the same day and doubled the reported usage, with both
rows individually correct, which is what made it invisible.

## Relationships crossing unit boundaries
| This table | -> | Other unit's table | Why it is allowed |
|---|---|---|---|
| config.userId | -> | identity.user.id | a config belongs to a user |
| config.grantId | -> | entitlement.grant.id | the Grant it was provisioned for (F-026-b; was `servicePlanId`) |
| config.tenantId, panel.tenantId | -> | tenant.tenant.id | dedicated pools / per-tenant scoping |
| config (referenced) | <- | billing.sub_account.configId | sub-account funds a config |

## Access rules

User panel: `config` by `tenantId` (index leads with it); `/sub`: by `grantId`, oldest
first (`(grantId, createdAt)`, F-027-bn). Traffic: ingestion writes, reporting reads.

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

`20260921000300_usage_is_billed_held_or_quarantined` adds the six tables
above with five new types. It is purely additive — nothing existing is altered
— and every byte column is `BIGINT`, because a 32-bit counter wraps at 4 GB,
which is the Gigawords trap arriving a second time in our own storage.

`20260921000400_a_radius_session_is_closed_not_abandoned` adds
`radius_session` and one new type. Additive in the same way, with three CHECK
constraints and the `(nasId, acctSessionId)` unique index.

`20260921000500_traffic_is_partitioned_by_month` is the first hand-written
file in this series: Prisma can express none of partitioning, a BRIN index or a
per-month table. It drops and recreates `traffic_raw_log` — a table cannot be
converted to a partitioned one in place — over the same emptiness assertion,
and adds the unique index to the rollup.

`20260921000800_traffic_raw_log_is_policied_like_the_rest` (F-027-ak) applies
RLS to `traffic_raw_log`: the partitioned parent **and** every partition carry
the strict list-A policies, and `ensure_traffic_raw_log_partition()` policies
each month it creates, so the gap cannot return on a clock.
`traffic_daily_aggregate` has no `tenantId` and no policy of its own — it is
reached through `configId` (open question, 2026-09-21).

`20260921000900_the_rollup_commits_before_the_partition_drops` (F-027-o): the
rollup's three `SECURITY DEFINER` functions, [contract.rollup.md](contract.rollup.md).
