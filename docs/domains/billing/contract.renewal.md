---
id: billing
layer: domain
status: active
version: 86
updated: 2026-10-22
---

# Contract — billing / renewing a Grant from the wallet (F-305, ADR-0158)

A topic file of `contract.md` (§10), beside [contract.purchase.md](contract.purchase.md):
a user extends a Grant they hold and pays for it from the wallet. The invoice, its
30-minute clock, its coupons and its payment are a purchase's. This file holds only
where a renewal differs. The admin's renewal (no money, F-311-d) is
[contract.reseller-grants.md](contract.reseller-grants.md). Both land in entitlement's
`renewGrant` (entitlement `contract.admin.md` "Renew").

**Status: the invoice (F-305-c), paying it (F-305-d) and the plans the sheet lists (F-305-j) are built.** F-305-e
(GiB and days) builds the rest; the rate it reads is catalog's
[contract.renewal-rate.md](../catalog/contract.renewal-rate.md) (F-305-b, built).
Consumers: panel-web [contract.renewal.md](../../interfaces/panel-web/contract.renewal.md)
(F-305-f/g), bot-app (F-305-i).

## The route (built — F-305-c)

`POST /api/billing/invoices` with `grantId` beside `variantId` (and `couponCodes?`):
`InvoiceService.create`, the rules in `invoice/renewal-invoice.ts` (`renewalOf`, pure),
proved by `invoice/renewal-invoice.spec.ts`; the plan is read by catalog's
`renewableOfferById`. The answer is a purchase's, plus `renewal: {grantId, bytes, days}`
(`bytes` a string, C-02), `null` on a purchase; `GET /api/billing/invoices/:id` answers it too.
The invoice row records `grantId`, `renewBytes`, `renewDays` (all or none, CHECK
`invoice_renewal_whole`) beside `priceId`, and `salesCounted: false`.

| Refusal | When |
|---|---|
| `404 errors.billing.invoice.grantNotFound`, `reason` `grant_not_found` | rule 1: not the caller's Grant, another tenant's (RLS), or unknown |
| `409 errors.billing.invoice.grantNotRenewable`, `reason` `grant_not_renewable` | rule 1: the Grant is `pending`, `exhausted`, `expired` or `cancelled` |
| `409 errors.billing.invoice.planNotRenewable`, `reason` `plan_not_renewable` | rules 3, 4, 6: the plan is gone, off, unpriced in the tenant's currency, of another product, panel group or billing mode; permanent against dated; a bag against unlimited; no traffic stated (F-111-p); or it adds nothing. A Grant issued with no plan (an import) has no product to renew within |

## The plans the sheet lists (built — F-305-j)

`GET /api/billing/gift/grants/:grantId/renewal-plans` — `RenewalPlansController` +
`InvoiceService.renewalPlans`; `renewablePlans` (pure, `renewal-invoice.spec.ts`) over the
product's variants read in one query (catalog `renewableOffersOf`). `@TenantCapability('sell')`,
the shop list's `SHOP_OFFERS` budget.

| Rule | Why |
|---|---|
| Answer `{grantId, ownPlanRenewable, plans: [{variantId, sku, nameKey, current, bytes, days, price, currencyCode, campaignEndsAt}]}`: exactly the plans `renewalOf` accepts, so the sheet never offers what the invoice refuses | one rule for the list and the invoice, as the shop's `forSale` and `create` |
| The Grant's own plan first (`current: true`), the rest by price; `ownPlanRenewable: false` = its plan is no longer sold (panel-web rule 3) | ADR-0158 (3) |
| `price` is the plan's in effect, before any discount; the invoice prices the codeless rule and the coupons | a discount depends on the codes typed |
| Refused as the invoice: `404 grant_not_found`, `409 grant_not_renewable`. A Grant issued with no plan lists nothing | rule 1 |

## What may be renewed, and to what (F-305-c)

| # | Rule | Why |
|---|---|---|
| 1 | **Only the caller's own Grant**, `active` or `suspended`, whatever the reason it is suspended. Another user's, another tenant's or an unknown id is one neutral `404`; any other status is refused | the user's own service; a closed Grant has nothing to extend |
| 2 | **A plan renewal is the variant as it is now**: today's bag (`quotas.traffic_bytes`), `durationDays` and price in effect, passed to `renewGrant` as a typed amount. Never the Grant's copy from its issue | ADR-0158 (1): the price is today's, so the bag is too |
| 3 | **The plan may be the Grant's own or another of the same product**, on the Grant's own panel group (entitlement invariant 31) and the same billing mode. It may be larger or smaller. The Grant's own plan is offered first | ADR-0158 (3) |
| 4 | **Renewable while the variant exists, is live, and has a price in effect** in the tenant's currency. `admin_only`, `unlisted`, sold out (F-513) or a full active cap (F-514) never refuse it. Neither does a product's audience (PT-1-b) or a reseller's package list (F-019-v5). A renewal is never held or counted by a cap | ADR-0158 (2): these say who may start a service; a renewal starts none |
| 5 | **Or GiB and days typed** (F-305-e): `{gib, days}` priced by the product's renewal rate in effect, within its bounds. No rate in effect = custom renewal off for that product (`custom_renewal_off`). Out of bounds, or both 0, is refused | ADR-0158 (4) |
| 6 | **Only the limited part is sold**: a metered Grant buys no GiB (its bytes are blocks, F-118); a Grant with unlimited traffic buys days only, one with unlimited days GiB only | the part already unlimited has nothing to add |
| 7 | **Discounts as a purchase**: the codeless rule, then the coupons, on the renewal's `amount` ("Discounts with no code" and "Coupon validation") | ADR-0158 (7) |

## The money (F-305-c, F-305-e)

| # | Rule | Why |
|---|---|---|
| 8 | **The server prices it** (spec §5.8): a plan renewal at the variant's price in effect; a typed one at `gib × pricePerGib + days × pricePerDay`, rounded **once**, up, to the currency's minor unit (`roundCharge`, ADR-0153) | a price in the body is stripped, as on a purchase |
| 9 | **The invoice records what priced it**: the price row (`priceId`), or the renewal-rate row and the GiB and days typed. Paying charges what was quoted, even if a newer row took effect in between | a rate is history (catalog `contract.renewal-rate.md` rule 1) |
| 10 | **In the tenant's operating currency.** A row in another currency is no rate (catalog invariant 11), so the plan or the custom renewal is not offered | as a price |

## Paying it (built — F-305-d)

`POST /api/billing/invoices/:id/pay`, the purchase's route and its first five steps
(`contract.purchase.md` "Paying it"); in place of the issue, `renewByInvoice`
(`invoice/renewal-payment.ts`), proved against a real Postgres by
`invoice/renewal-payment.int.spec.ts`. It asks rules 1–4 and 6 again at that instant
(`renewalSaleOf`) and adds the bytes and days **quoted** (rule 9). The answer is the
purchase's, `grants: [{id, status}]` naming the renewed Grant (`active` once revived).
No Grant is issued, no unit of the variant sold (`salesCounted` stays false); the
debit is `product_purchase`, as a purchase's. A Grant closed or a plan switched off
since the quote is the create's `409` (`grant_not_renewable` / `plan_not_renewable`),
and the whole payment rolls back. A revival writes no notice (`tellReactivated: false`):
the payer pressed pay, as with their own freeze.


| # | Rule | Why |
|---|---|---|
| 11 | **The purchase's transaction, with one step changed**: in place of issuing a Grant, `renewGrant` on the invoice's Grant, under its row lock. One `grant_renewal` row names the user as actor and the invoice as request | one request, one renewal (entitlement invariant 27) |
| 12 | **A plan switch writes the Grant's new variant, bag and period** in the same transaction. Its next renewal is of that plan | ADR-0158 (3) |
| 13 | **A reseller's package plan on a platform panel buys its bag wholesale** in the same transaction (entitlement invariant 30); a shortfall is the purchase's (`insufficient_balance` + `facts`, F-111-c) | the platform is paid for every byte it serves |
| 14 | **The page hears it**: the payment writes `entitlement.grant.renewed` `{tenantId, userId, grantId, invoiceId, renewalId}`, live-only to `user:` (realtime `contract.live-events.md`, C-14, ADR-0121); My services re-reads the Grant on it | no page polls for a renewal |
