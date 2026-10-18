---
id: catalog
layer: domain
status: active
version: 13
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
| 4 | A pending invoice holds a unit as a sale does; payment moves it to sold; expiry, cancel or refund releases it — so two buyers never oversell the last unit | billing, F-513-b (todo) |
| 5 | A free-grant coupon and the wheel count and are refused when sold out; an admin's or a reseller's issue counts and is never refused | billing, F-513-b (todo) |
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

The counters have no writer yet: F-513-b adds billing's reserve / sell /
release through this unit, under the variant's row lock.
