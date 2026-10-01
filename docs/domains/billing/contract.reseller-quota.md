---
id: billing
layer: domain
status: active
version: 3
updated: 2026-10-01
---

# Reseller quota — what a package sells, counted, and sold past or stopped

What governs the quota engine (F-019-v2, F-019-v6, ADR-0107 points 3-7, 10, 12): one
call where a quota is consumed, one where the act is given back. What a quota key
*is* — kind, number, `stop`/`overage` at three levels — is
[tenant/contract.limits.md](../tenant/contract.limits.md). Read this before
consuming a quota anywhere, or before adding a new one (tickets, AI requests).

Code: `shared-core/src/lib/billing/reseller-quota.ts` (`ResellerQuota`,
`quotaTermsOf`, `ResellerQuotaExhausted`), `quota-period.ts` (`quotaPeriodAt`),
`product-quota.ts` (a product's sales, F-019-v6).
Proof: `reseller-quota.spec.ts`, `product-quota.spec.ts` (same folder).

## The calls

| Call | Does |
|---|---|
| `ResellerQuota.consume(tx, {tenantId, meter, qty, sourceRef, now?})` | a registry quota key: resolves its terms (`quotaTermsOf`: number and overage at their levels, held for the paid period — tenant `contract.limits.md`, F-019-v3), then `consumeMeter` |
| `ResellerQuota.consumeMeter(tx, {tenantId, terms, qty, sourceRef, now?})` | against `QuotaMeterTerms` the caller resolved (`{meter, windows: [{period, included}], overage}`, shortest window first; a registry key has one) — how a meter not in the registry (a product's sales, F-019-v6) uses the same engine |
| `ResellerQuota.admit(tx, {tenantId, terms, qty, now?})` | throws what `consumeMeter` would now — `wallet_empty` read from the balance — and writes nothing: a check before the act exists (an invoice, F-019-v6) |
| `ResellerQuota.release(tx, {tenantId, sourceRef, now?})` | gives back every live row of the act, in meter order → `{released, refunded: [{amount, currencyCode}]}` |
| `ResellerQuota.statementOf(tx, tenantId, key, now?)` | `{meter, period, included, includedUsed, overageQty, overageAmount, overage, spend}` — "10 included, 4 used, 2 extra today" |
| `ResellerQuota.meterStatementOf(tx, tenantId, terms, now?)` | `{meter, windows: [{period, included, includedUsed, overageQty, overageAmount}], overage}` — a meter of several windows (a product's), each counted over its own period by rule 4; a unit sold past is in every window whose period holds it, charged once (4b) |
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
| 4. Used = the `includedQty` of live rows **created** in the period. Each row also stores the period it fell in (its first window's), for the statement | a released row gives its units back; a changed zone or a renewal never moves past rows |
| 4b. **Several windows** (F-019-v6, user 2026-10-01): each window bounds the units *included* in it; the act takes the least room any window has; a unit past any window is overage once, at the meter's one price — never once per window — and uses no window's included room. A `stop` refusal names the tightest window's `included` / `used` | "10 a day, 50 a week" is explainable on a statement, and one sale is never charged twice |
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
stoppedBy, included, used}`. Its `refusal` is what a route answers the
reseller with (409), the same for every quota: a `stop` on a registry key is
`reseller_limit_reached` `{key, limit, used}`, the refusal every limit gives and
the panel names; anything else keeps its reason and says why. What a buyer
hears is "not available now", never the figures (point 11, F-019-v11).

**The reseller is told** (F-019-v8, notification
[contract.reseller-quota.md](../notification/contract.reseller-quota.md)):
`consumeMeter` writes the 80% / 100% alerts in the act's transaction after its
usage row; every refusal, at `consume` or `admit`, is reported to the sink a
service registers with `setQuotaRefusalSink` and recorded on its own
connection. A new quota key needs no code for either.

## Adding a quota — the how-to (tickets, AI requests)

`campaign_sends_daily_max` is the worked example (F-019-v4,
`notification-service/.../campaign-admin.service.ts` `send`). For a new key:

1. **Registry** (`shared-core/src/lib/tenant/reseller-limits.ts`): a line
   `{ kind: 'quota', period: 'day' | 'week' | 'month', default, max }`. A sub-cent
   unit (one AI request) is priced as a bundle: the key counts bundles (rule 8).
2. **Usage** (`reseller-limit-usage.ts`): the key's entry is `null` — the
   engine counts it, and `GET …/limits` shows the statement.
3. **Consume** where the act commits, in its transaction, before the write
   that makes it real:
   `ResellerQuota.consume(tx, {tenantId, meter: '<key>', qty, sourceRef: '<kind>:<the act's id>'})`.
   The `sourceRef` names the act, so a retry is a replay. Skip it for the
   platform's own people acting on a reseller (ADR-0106 point 4).
4. **Refuse** with `e.refusal` on `ResellerQuotaExhausted` (409); never
   invent a reason.
5. **Give back** with `release(tx, {tenantId, sourceRef})` where the act is
   cancelled or refunded, if it can be.
6. **Panel**: the key's name in `site-pwa/src/lib/reseller-limits.ts` and its
   locale entry, as every limit key has.

No table, no migration, no new route: the `/overage` routes, the period lock
(F-019-v3) and the reseller's statement already cover every quota key.

## A product's sales (F-019-v6, ADR-0107 points 3, 10, 11)

`product-quota.ts`. The terms are the package's listing (tenant `contract.limits.md`,
`package_product`): `day` / `week` / `month` included, each optional, and one
`stop`/`overage` with its price. Only a **platform** product sold by a reseller is
counted; its own products and the platform's tenant never are.

| Rule | Held by |
|---|---|
| One meter per product, `product:<productId>`, counted over **all** the reseller's sales of it | `productQuotaMeter` |
| A sale is a Grant of it **bought, redeemed from a gift code, or issued by the reseller's own people** (user, 2026-10-01) — not a renewal, not the platform's staff. `sourceRef` = `grant:<grantId>`, consumed in the Grant's transaction after its row | `consumeProductSale` in entitlement `issue` (purchase, coupon) and `issueGrantByAdmin` (bounded) |
| Asked at invoice create too, writing nothing (`admit`) — the buyer is refused before paying; the issue asks again under the lock | `admitProductSale` in `InvoiceService.create` |
| **Given back only by a sale never served** (user, 2026-10-01): a purchase whose delivery failed and was refunded whole releases its units and overage. A service used, then deleted by the reseller, keeps them | `release` in `GrantDeliveryService.refund`; `deleteGrant` does not release |
| Terms held for the paid period, window by window, the kinder part winning; a listing taken off is still sold on them until the period ends | `productQuotaTermsOf`, `lockProductQuotaTerms` (tenant `contract.limits.md`) |
| The reseller's statement: every product it sells now — listed, or taken off and held this period, as `platformProductsSoldBy` counts — with `termsFrom`'s terms and `meterStatementOf`; nothing for a non-reseller or one with no subscription (F-019-v10) | `productQuotaStatementsOf`; tenant `GET …/limits/products` |
| Refused: the buyer (invoice, payment, gift code) **409** `notAvailableNow`, `reason` `reseller_quota_exhausted`, no figures; the reseller's admin **409** `e.refusal` with them | the routes' error maps |

The panel names a refusal by `stoppedBy` (panel-web `contract.reseller-limits.md` rule 22).
