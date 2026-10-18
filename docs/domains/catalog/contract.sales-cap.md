---
id: catalog
layer: domain
status: active
version: 14
updated: 2026-10-18
---

# Contract — catalog / a variant's sales cap (F-513)

At most `salesCap` of one variant are sold, then it is sold out (catalog
F-513, user decisions 2026-10-18). `sales-cap.ts` in
`billing-service/src/app/catalog/`; the cap is set through the variant routes
of [contract.md](contract.md).

## Storage

`product_variant.salesCap` (null = no cap, CHECK `> 0`), `soldCount` and
`reservedCount` (both `≥ 0`, default 0) — [data-model.md](data-model.md),
migration `20261018000500`. No CHECK ties the counts to the cap: see rules 3
and 5.

## Rules

| # | Rule | Held by |
|---|---|---|
| 1 | The cap is per variant, never per product (user, 2026-10-18) | the column |
| 2 | `remaining = max(0, salesCap − soldCount − reservedCount)`, `null` with no cap; `soldOut` is `remaining = 0` | `salesOf` (`sales-cap.spec.ts`) |
| 3 | An admin may lower the cap under what is sold and held: sales close, none is undone | no CHECK; `salesOf` floors at 0 |
| 4 | A pending invoice holds a unit as a sale does; payment moves it to sold; expiry, cancel or refund releases it — so two buyers never oversell the last unit | `moveSales` under the variant's row lock; `invoice.salesCounted` (`sales-counts.spec.ts`, `invoice.spec.ts`) |
| 5 | A free-grant coupon and the wheel count and are refused when sold out; an admin's or a reseller's issue counts and is never refused | `SALE_COUNTING` in `GrantService.issue` (`sales-counts.spec.ts`) |
| 7 | An invoice made before the counts (`salesCounted = false`) gives back nothing at expiry, cancel or refund; paid, it is counted, never refused | `releaseSalesUnit`, `InvoicePaymentService.pay` |
| 6 | A sold-out variant is still listed, marked `soldOut` — the shop shows it, never hides it | `listOffersIn` / `toOffer` |

## HTTP surface

`POST /products/:id/variants` and `PATCH /variants/:id` (and the reseller
routes over the same service, F-066-w7) take `salesCap?: integer 1..1 000 000 | null`
— `null` clears it, absent leaves it. Anything else is a schema 400. Every
variant view answers `sales: {cap, sold, reserved, remaining, soldOut}`, and
the edit is audited with it (`catalog_variant_update`).

## Provides

| What | Answer |
|---|---|
| `CatalogOffer.remaining` / `.soldOut` — `listOffersIn`, `offerBySku`, `sellableOfferById` | rule 2 for the variant read in the caller's transaction |
| `salesOf(counts)`, `MAX_SALES_CAP` | the pure rule, for billing's checks (F-513-b) |
| `moveSales(tx, variantId, move)` — built (F-513-b) | the counts' only writer, in the caller's `tenantTransaction`; throws `VariantSoldOut` |
| `countSaleOf(tx, variantId, source)` | what an issued Grant of `source` does to the counts (`SALE_COUNTING`) |

## The writers (F-513-b)

`sales-counts.ts`. Every move is one call of `catalog.move_variant_sales`
(migrations `20261018000600`, `…0700`), a SECURITY DEFINER function: a
reseller's users buy the platform's variants, and `tenant_isolation`'s
WITH CHECK refuses a reseller's transaction writing a platform row (proved on
dev, 2026-10-18). It writes the two counts only, of a variant the bound tenant
can read, and its UPDATE is the row lock two buyers of the last unit queue on.

| Move | sold / held | Refused when full | Who |
|---|---|---|---|
| `reserve` | 0 / +1 | yes — `409 errors.billing.invoice.soldOut`, `reason` `sold_out` | `InvoiceService.create`, before the row and its coupon holds |
| `sellReserved` | +1 / −1 | no | `InvoicePaymentService.pay` |
| `release` | 0 / −1 | no | invoice cancel and the expiry sweep |
| `unsell` | −1 / 0 | no | delivery's refund of a paid invoice |
| `sell` | +1 / 0 | yes — `EntitlementRefused('sold_out')` | issue of `coupon` (`409 errors.billing.gift.soldOut`, the use rolled back), `engagement_reward` (the spin goes on with no prize), `trial`, `affiliate_reward` |
| `count` | +1 / 0 | no | issue of `admin_grant` — platform or reseller staff; an invoice paid from before the counts |

`purchase` (its invoice holds the unit), `migration` and `rollover` (no new
sale) move nothing at issue. A give-back past zero is the CHECK's error, a bug,
never floored. Counts move for an uncapped variant too, so a cap set later
starts from what was sold since F-513-b.

**The event (C-14).** A move of a **capped** variant writes one
`catalog.variant.sales_changed` `{catalogId, tenantId, variantId}` (`aggregate:
'catalog.variant'`) on its owner's catalog channel (realtime RT-1-p):
`catalog:platform` for a platform variant, which every reseller's shop hears,
else `catalog:<ownerTenantId>`. One row however many resellers sell it. An
uncapped move writes none: no page shows it as left.
