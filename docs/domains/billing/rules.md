---
id: billing
layer: domain
status: draft
updated: 2026-09-04
---

# Business rules — billing (DRAFT, from schema comments)

## Payment state machine
`pending` -> `success` | `failed` | `expired` (usually `now()+15min`).
Confirmation sources: `webhook_auto`, `reconciliation_auto`, `admin_manual`
(the last requires `manualConfirmReason`).

## Coupon redemption state machine
`pending` -> `confirmed` | `expired` | `cancelled`. `reservedCount` holds stock
while `pending`; `usedCount` increments on `confirmed`.

## Wallet transfer state machine
`pending_otp` -> `confirmed` | `cancelled` (>5 OTP tries) | `expired`.

## Rules
| # | Rule | Trigger | Exception |
|---|---|---|---|
| 1 | Fee is computed per gateway: `manual` vs `automatic`, `fixed` vs `percentage`, with optional floor/ceiling | payment start | — |
| 2 | Tax is charged on the top-up, never on a sale (ADR-0076, superseding ADR-0038): the gateway's `taxRatePercent`, else the tenant's `deposit_setting` default, null = none. `priceAtGateway` charges it on the basis, half-up, and the intent freezes `taxApplied` + the rate (F-104-af) | payment | — |
| 3 | Coupon `minPurchaseAmount` / `maxDiscountCap` (percentage only) bound the discount | redeem | — |
| 4 | Targeted coupon (`visibility = targeted`) requires a `coupon_allowed_user` row | redeem | — |
| 5 | Affiliate commission is separate from `identity.user.referredByUserId` — it needs its own status ledger | payment success by referred user | — |
| 6 | Money is rounded once, at the write, to the row currency's `decimalPlaces` (`currencyPlacesOf`), by `shared-core`'s `money-rounding.ts`: a charge up, a credit, discount or hold down, a price or conversion half up and never to nothing, parts summing to their whole (ADR-0153, F-116-p; C-02 check) | every money write | analytics' shown averages, until F-116-r |

## Edge cases decided
| Case | Decision | Date |
|---|---|---|
| Crypto rate moves after intent | never recompute; use `exchangeRateSnapshot` | 2026-09-04 (schema) |
| Reconciliation finds gateway says paid, we say pending | `auto_confirmed`; if amounts differ -> `flagged_mismatch` | 2026-09-04 (schema) |
