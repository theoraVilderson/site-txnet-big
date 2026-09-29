---
id: entitlement
layer: domain
updated: 2026-09-27
---

# Data model — entitlement

Source of truth: `txnet-backend/prisma/domains/entitlement.prisma` (Postgres
schema `entitlement`), migrations `20260914001600_entitlement_grant` and
`20260921000600_a_grant_buys_its_bytes_before_it_serves_them` and
`20260925000700_grant_delivery_clock` and
`20260926000400_an_unlimited_grant_says_so`,
`20260927001100_a_grant_asks_if_it_connected` and
`20260927001200_a_grant_counts_its_usage_period` and
`20260927001800_a_used_grant_checks_in_when_idle` and
`20260927002000_a_grant_forecasts_its_volume` and
`20260927002100_a_grant_is_frozen`,
`20260928000100_a_grant_remembers_its_days` and
`20260928000500_an_admin_renews_a_grant`.

## Tables owned
| Table | Purpose | Tenant-scoped? | Retention |
|---|---|---|---|
| grant | one entitlement: user, variant, `source` + `sourceReferenceId`, `status`, `startsAt`/`endsAt`, `billingMode`, `featureKeys`, `quotas` copied from the variant, `sharingPolicy`, `subscriptionTokenHash` + `subscriptionTokenSealed` (ADR-0085), `userLabel` (the buyer's own name for the service, display only; trimmed, 1..40 — CHECK `grant_user_label_shape`; null = the catalog's name, F-307-x), the three byte cursors (`billedBytes`, `consumedBytes`, `purchasedBytes`), `meteredRate`, `suspendedAt`, `purgeAfterDays`, `resellerPath`, `trafficUnlimited` (F-111-q: sold with `limit = 0`; CHECK `grant_traffic_unlimited_is_prepaid` — prepaid, `purchasedBytes = 0`), the delivery clock `deliveryAttempts` (CHECK ≥ 0) + `nextDeliveryAt` (index `grant_status_nextDeliveryAt_idx`, F-111-d), `deliveryDelayedAt` (the check that announced a purchase still waiting 5 minutes on, set once; no index, F-601-i), `usagePushedAt` (F-307-t: metering's 30 s slot for `entitlement.grant.usage`; a throttle, not a record), `activatedAt` (first `active`: delivery, or `startsAt` for a Grant born active) + the "not connected yet?" clock `unusedCheckAt` (index `grant_status_unusedCheckAt_idx`, F-601-c; null for Grants from before it), the usage period `usagePeriodFromBytes` (`consumedBytes` when it opened, default 0) + `usagePeriodStartedAt` (null = `startsAt`), written by a renewal that adds bytes (F-601-d), the time-threshold clock `endNoticeFor` (the `endsAt` it was set for) + `endNoticeAt` (that end's next level; index `grant_status_endsAt_idx`, F-601-e), `endSetAt` (when the current end was set — issue, renewal, admin days; not an unfreeze; its span decides which levels are news; null = permanent, F-601-r), `usageNoticeLevel` + `usageNoticeSince` (a 50 / 80 % level held up to 24 h; index `grant_status_usageNoticeSince_idx`, F-601-n), `lowBalanceNoticeAt` (a metered wallet's low-balance crossing told, null = armed; no index, read only on the row a block purchase holds, F-601-g), `purgeNoticeFor` (the `suspendedAt` whose purge was told a day ahead; no index, the purge scan's, F-601-j), `idleCheckAt` (7 days after the last charge that consumed a byte, set by metering, cleared by the check; index `grant_status_idleCheckAt_idx`, F-601-l), `forecastNoticeFor` (the usage period whose exhaustion forecast was told; no index, the sweep's candidates come off the idle index, F-602), `trafficResetFromBytes` (Used at the last admin traffic reset, default 0; CHECK ≥ 0; a cursor, never the meter, F-311-k), `frozenUntil` (when a timed admin freeze ends by itself, null = until unfrozen; only on a `suspended` + `admin_frozen` Grant, after `suspendedAt` — CHECK `grant_frozen_until_is_frozen`; index `grant_status_frozenUntil_idx`, F-311-h) , `periodDays` (the plan's period, copied from `durationDays` at issue; null = permanent or no variant; backfilled from the variant for older Grants — what an admin's renewal of one period adds, F-311-d) | yes, strict RLS | permanent |
| quota_adjustment | a signed `delta` on one `metric` of a Grant, with its `source`, optional `capPercent` and `expiresAt`; append-only | yes, strict RLS | permanent |
| grant_duration_change | an admin's move of a Grant's `endsAt` (F-311-i): `actorUserId` (no FK — may be platform staff), `endsAtBefore`, `endsAtAfter` (CHECK `grant_duration_change_moves`: they differ), `reason` (CHECK non-blank); index `(grantId, createdAt)`; append-only (`grant_duration_change_is_history`), its Grant's tenant's (`same_tenant()`) | yes, strict RLS | permanent |
| grant_renewal | an admin's renewal of a Grant in place (F-311-d), one per request (unique `requestId`): `actorUserId` (no FK), `plan` (the plan's period, or typed), `bytes`, `days`, `forgivenBytes`, `purchasedBytesBefore`/`After`, `endsAtBefore`/`After` (null = permanent), optional `reason` — CHECK `grant_renewal_adds` (≥ 0, not both 0); index `(grantId, createdAt)`; append-only (`grant_renewal_is_history`), its Grant's tenant's (`same_tenant()`) | yes, strict RLS | permanent |
| grant_meter | a meter the Grant was sold with (F-118-e, ADR-0105 decision 4), one per `(grantId, meterKey)`: the card in effect at issue copied — `rateCardId` (no FK: a card goes with its variant), `unitSize`, `unitPrice` `Decimal(18,8)`, `currencyCode`, `mode`, `includedQuantity`, `afterIncluded` — and the counters `consumed`, `billed` (the rating cursor), `funded`, in the meter's unit (CHECK ≥ 0). Terms locked, never deleted (`grant_meter_terms_are_locked`); the card's CHECKs held again; its Grant's tenant's (`same_tenant()`). No backfill: a Grant issued before it has only `meteredRate`. Until F-118-l a VPN Grant's byte cursors are the truth and these counters stay 0 | yes, strict RLS | permanent |
| grant_deletion | an admin's delete of a Grant (F-311-m), one per Grant (unique `grantId`): `actorUserId` (no FK), `reason` (CHECK non-blank), `statusBefore`, `refundRemainder` (the admin's answer), `refundedAmount` `Decimal(18,2)` + `walletTransactionId` (no FK — billing's row; both or neither, only with `refundRemainder`), `refundSkipped` (F-027-r's reason a refund asked for credited nothing) — CHECK `grant_deletion_refund_asked`; append-only (`grant_deletion_is_history`), its Grant's tenant's (`same_tenant()`) | yes, strict RLS | permanent |

`grant` is a reserved word: SQL quotes it (`entitlement."grant"`).

## Relationships crossing unit boundaries
| This table | -> | Other unit's table | Why it is allowed |
|---|---|---|---|
| grant.userId | -> | identity."user".id | whose |
| grant.variantId | -> | catalog.product_variant.id | what was issued (null for a `migration` Grant) |
| grant.tenantId | -> | tenant.tenant.purgeAfterDays | the purge window, read live (F-027-f) |
| grant_meter.meterKey | -> | catalog.meter.key | what is counted (RESTRICT; a meter is immutable) |
| grant (referenced) | <- | network.config.grantId | a config draws on its Grant's quota (§4.6) |

## Access rules

Written only through the entitlement module in `billing-service` (ADR-0049).
A link lookup hashes the arriving token and reads by
`grant_subscriptionTokenHash_key`. The token itself is stored only sealed
(`subscriptionTokenSealed`, ADR-0085), and only `subscriptionTokenFor` opens it.

## The three byte cursors (F-027-f, ADR-0072)

They are three columns on purpose, and each moves for its own reason:

| Column | What it counts | Who advances it |
|---|---|---|
| `purchasedBytes` | bytes paid for. `Σ ceilings ≤ purchasedBytes` across every config of the Grant (ADR-0072 rule 1) | `GrantService.issue` for a **prepaid** Grant: the sold `traffic_bytes` limit, at issue (ADR-0072: a package is a fixed bag); for a metered one, the block purchaser (F-027-q, `billing/contract.traffic-block.md`) |
| `billedBytes` | the money cursor — how far the wallet has been debited, **net of what came back** | the block purchaser, in the same transaction and by the same figure; and the remainder credit at close, which brings it down alone (F-027-r) |
| `consumedBytes` | what the panels reported. **Measured, not paid for** | the delta consumer, F-027-n |

`consumedBytes` is deliberately not constrained against `purchasedBytes`: a
panel whose limit was overridden serves past the ceiling, and that gap is an
accounting truth for the holds queue (ADR-0074), not a write to refuse.

`meteredRate` is `Decimal(18, 8)` per 2^30 bytes, copied at issue beside the
quotas by `GrantService.issue` — the rate in effect at `startsAt` (F-027-p,
ADR-0073) — and null unless `billingMode = metered`. Amounts derived
from it are still whole cents before the ledger (`C-02`).
`meteredRateCurrencyCode` is the rate's currency, locked with it (F-116-d): a
block is debited and a remainder credited in it, set exactly when the rate is
(`grant_metered_rate_currency_with_rate`); rows from before were backfilled `USD`.

## The purge clock (F-027-f, ADR-0075)

`suspendedAt` starts it; `tenant.purgeAfterDays` (default 7, `0` = never) is
its length, read **as it is now** rather than copied at issue, so a tenant that
shortens it means it for the Grants already waiting. `grant.purgeAfterDays` is
an override and is null unless someone set one. Resolution is
`coalesce(grant.purgeAfterDays, tenant.purgeAfterDays)`, and it happens inside
the purge sweep's scan (F-027-y, `entitlement/purge.ts`) rather than in TypeScript
after it — `grant_status_suspendedAt_idx` orders that scan oldest-first and it
takes a bounded batch, so a `0` filtered out afterwards would occupy the batch
for ever and starve the rows behind it. A frozen Grant (`statusReason =
admin_frozen`, F-311-h) carries the clock the CHECK asks for but is never
purged: the scan excludes the reason.

## Migration notes

`20260914001600` creates the schema, refuses to run over `network.config` rows,
and makes `config.grantId` NOT NULL. `resellerPath` is TEXT until reseller nodes
(`ltree`, F-901) exist.

`20260921000600` is additive — every column nullable or defaulted — and its two
non-negativity CHECKs also cover the pre-existing `billedBytes`.
