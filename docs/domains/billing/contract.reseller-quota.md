---
id: billing
layer: domain
status: active
version: 1
updated: 2026-10-01
---

# Reseller quota — what a package sells, counted, and sold past or stopped

What governs the quota engine (F-019-v2, ADR-0107 points 4-7, 10, 12): one
call where a quota is consumed, one where the act is given back. What a quota key
*is* — kind, number, `stop`/`overage` at three levels — is
[tenant/contract.limits.md](../tenant/contract.limits.md). Read this before
consuming a quota anywhere, or before adding a new one (tickets, AI requests).

Code: `shared-core/src/lib/billing/reseller-quota.ts` (`ResellerQuota`,
`quotaTermsOf`, `ResellerQuotaExhausted`), `quota-period.ts` (`quotaPeriodAt`).
Proof: `shared-core/src/lib/billing/reseller-quota.spec.ts`.

## The calls

| Call | Does |
|---|---|
| `ResellerQuota.consume(tx, {tenantId, meter, qty, sourceRef, now?})` | a registry quota key: resolves its terms (`quotaTermsOf`: number and overage at their levels, held for the paid period — tenant `contract.limits.md`, F-019-v3), then `consumeMeter` |
| `ResellerQuota.consumeMeter(tx, {tenantId, terms, qty, sourceRef, now?})` | against `QuotaMeterTerms` the caller resolved (`{meter, period, included, overage}`) — how a meter not in the registry (a product's sales, F-019-v6) uses the same engine |
| `ResellerQuota.release(tx, {tenantId, sourceRef, now?})` | gives back every live row of the act, in meter order → `{released, refunded: [{amount, currencyCode}]}` |
| `ResellerQuota.statementOf(tx, tenantId, key, now?)` | `{meter, period, included, includedUsed, overageQty, overageAmount, overage, spend}` — "10 included, 4 used, 2 extra today" |
| `ResellerQuota.spendOf(tx, tenantId, now?)` | `{month, cap, spent, currencyCode}` — this subscription month's overage against the reseller's cap |

Each takes the caller's `tx` and opens none: the act and its quota commit
together or not at all. On the app pool, call it in the reseller's own scope
(every table here is strict-RLS); a platform surface passes its cross-tenant pool.

## Rules

| Rule | Why |
|---|---|
| 1. **One row per act**: `reseller_quota_usage` is unique on (tenant, meter, `sourceRef`). Consuming the same act again answers that row (`replay: true`), writes and charges nothing | a retried request is harmless |
| 2. A released act cannot consume again under its reference (`ResellerQuotaSourceReleased`) | a new attempt is a new act with its own `sourceRef` |
| 3. **Fixed periods** (point 7): `day` from 00:00, `week` from Saturday 00:00, on `tenant_subscription_setting.quotaTimeZone` (default `Asia/Tehran`); `month` = the subscription month, stepped a calendar month from `currentPeriodEnd` (UTC, clamped like the renewal), or the calendar month on that clock with no subscription | a statement must be explainable; a yearly plan is counted in its months |
| 4. Used = the `includedQty` of live rows **created** in the period. Each row also stores the period it fell in, for the statement | a released row gives its units back; a changed zone or a renewal never moves past rows |
| 5. A per-(tenant, meter) advisory lock before reading; one act's units are split into included and overage under it | two acts cannot both take the last included unit |
| 6. **Past what is included, the whole act or nothing**: `stop` mode, an empty wallet (`wallet_empty`), the reseller's spend cap (`spend_cap`), or a price not in the wallet's currency (`price_unavailable`) throws `ResellerQuotaExhausted` before any write — no usage row, no ledger row | a caller never gets half its units; an act paid half is a state nobody asked for |
| 7. **Prepaid overage** (point 5): `overageQty × unitPrice` debited from the reseller's billing wallet through `TenantBillingLedger` (`quota_overage_charge`, `referenceId` = the usage row) in the caller's transaction; the row names the entry (`chargeTransactionId`), and a CHECK holds `overageAmount = overageQty × unitPrice` | no invoice, no debt (ADR-0107, rejected: month-end invoices) |
| 8. The unit price is a whole minor unit (`Decimal(18,2)`): the ledger never rounds | a sub-cent unit (one AI request) is priced as a bundle when its key is added |
| 9. **The spend cap** (point 6): `reseller_overage_cap` (no row = none, `0` = no overage at all), compared with this subscription month's live overage in the same currency, under a per-tenant lock taken only to charge | two meters charging at once cannot both pass the cap |
| 10. **Release gives back** (point 10): each live row is marked `releasedAt` once (`updateMany … releasedAt: null`); a charge is credited back (`quota_overage_refund`, same reference, in the currency it was charged in — the ledger converts across a platform change), and the row names it (`refundTransactionId`) | units and money return exactly once |
| 11. `qty` is a whole number above zero; a tenant that is not a reseller is exempt — `{exempt: true}`, nothing counted or written | the platform is never bounded by itself (ADR-0106 point 4) |
| 12. No limit (`included: null`) counts every unit as included and never charges | the statement still says what was used |
| 13. Several meters in one transaction are consumed in meter order | the advisory locks are then always taken in one order |

`ResellerQuotaExhausted`: `reason` `reseller_quota_exhausted`, `facts {meter,
stoppedBy, included, used}`. What the buyer hears is "not available now",
never the figures (point 11, F-019-v11). The reseller is told by F-019-v8.

## Adding a quota

A `kind: 'quota'` line in `RESELLER_LIMITS` with its `period`, then one
`ResellerQuota.consume(tx, {tenantId, meter: '<key>', qty, sourceRef: '<the act's id>'})`
where the act commits, and `release` where it is cancelled. No table, no
migration, no new route: the platform owner's `/overage` routes and the
reseller's statement already list every quota key.

## Not yet

The first consumer is F-019-v4 (`campaign_sends_daily_max`, still counted
by F-019-t4's rolling 24 hours until then). Product sales quotas are
F-019-v6 (a `consumeMeter` caller brings its own terms, so it locks them itself); alerts F-019-v8.
