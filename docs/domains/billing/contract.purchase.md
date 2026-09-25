---
id: billing
layer: domain
status: active
version: 2
updated: 2026-09-25
---

# Contract — billing / purchase

A topic file of `contract.md` (§10): buying a catalog product from the wallet
(spec §5.8 Purchase Settlement Flow — `python3 tools/spec.py --section 5.8`).
Step 1, the invoice, is built (F-111-a), and step 2, paying it from the wallet
(F-111-b). The shortfall (F-111-c) and delivery (F-111-d) are not yet.
Consumer: the panel's shop page (F-111-e).

## Creating an invoice (built — F-111-a)

`POST /api/billing/invoices` — `InvoiceController` + `InvoiceService` in
`billing-service/src/app/invoice/`, proved by `invoice/invoice.spec.ts`. Behind
the gate like every billing route ("Request edge" in `contract.md`).

| Body | Answer (201) |
|---|---|
| `variantId` (uuid), `couponCodes?` (≤ 10, ≤ 64 chars each) | `{id, variantId, sku, nameKey, status: "pending", amount, discount, total, applied: [{code, discount}], rejected: [{code, reason, message}], expiresAt}` — money as decimal strings, base currency (C-02) |

| Rule | Held by |
|---|---|
| **The server prices it.** `amount` is the catalog price row in effect now, in USD; the body has no price field, and one sent (`price`, `amount`, `total`) is stripped by the schema — ignored, not validated (spec §5.8) | `invoiceCreateSchema` (not strict), `InvoiceCreateRequest` has no price |
| For sale to **this** tenant, or a neutral `404 errors.billing.invoice.variantNotFound`: live variant, product and category; `public` or `unlisted` (a direct link is a way to buy); a price in effect; RLS returns only the tenant's own variants and the platform's | `sellableOfferById` (catalog's rules, `offers.ts`) |
| The tenant's status: `@TenantCapability('sell')` — suspended, terminated or onboarding sells nothing (`403`) | `TenantStatusGuard` |
| Coupons are validated against this variant and its product (`target: purchase`), with the discount engine's order and gates ([contract.md](contract.md) "Coupon validation"). A code that fails is in `rejected`, with its i18n message, and the invoice is made without it — the shopper removes it or buys | `CouponValidationService` |
| The applied codes are **held** under the invoice's id (`orderReferenceId`), in the same transaction as the row. A hold that can no longer be taken is `409` with the code's reason, and nothing is written | `CouponReservationService.reserve` |
| A free variant (price `0`) asks no coupon engine; every code typed is `nothing_to_discount` | `InvoiceService.create` |
| `total = amount - discount`, `0 <= discount <= amount`, `amount >= 0` — CHECKs; `priceId` names the price row used | migration `20260925000400_invoice` |
| `expiresAt` = creation + 30 minutes (`INVOICE_TTL_MS`) | `InvoiceService.create` |
| Per user, `INVOICE_CREATE` bucket, `INVOICE_CREATE_RATE_LIMIT` (20) per 15 min | `@RateLimit` |
| **Not yet checked:** governance restrictions and the reseller cap (F-904) — added here once their units exist | — |

## The clock (built — F-111-a)

`worker-service` job `invoice_pending_expiry` (seeded `always_on`) calls
`POST /api/internal/billing/invoices/expire-pending` (`ServiceOnlyGuard`, 404
otherwise) → `InvoiceExpiryService.expirePending()` → `{scanned, expired, holdsReleased}`.

| Rule | Why |
|---|---|
| Scan on the cross-tenant pool (`pending`, `expiresAt <= now`, oldest first, `PAYMENT_EXPIRY_BATCH_SIZE`); each write in the invoice's own `tenantTransaction` | the coupon functions scope by `app.tenant_id` |
| The flip to `expired` is guarded by `status = pending` and the clock; the holds are released `expired` only when that flip matched | an invoice paid between scan and write keeps its uses |
| Released **at once**, unlike a top-up's (F-092-ah) | a wallet payment takes the invoice's own row lock (F-111-b), which this flip waits on; after it nothing can pay the invoice, so there is no late credit to wait for |

## Paying it (built — F-111-b)

`POST /api/billing/invoices/:id/pay` — `InvoicePaymentService` in
`invoice/invoice-payment.service.ts`, proved against a real Postgres by
`invoice/invoice-payment.int.spec.ts`. `@TenantCapability('sell')`, no body.

| Answer | When |
|---|---|
| `200 {id, status: "paid", total, balanceAfter, walletTransactionId, grants: [{id, status: "pending", token}]}` | paid. `token` is the subscription key, shown this once (entitlement `issue`) |
| `404 errors.billing.invoice.notFound` | unknown, another tenant's (RLS) or another user's — never told apart |
| `409` `reason`: `already_paid` / `expired` / `cancelled` | its i18n key beside it. Past `expiresAt` is `expired` even before the sweep flips it |
| `409 insufficient_balance` + `shortfall: {total, balance, missing}` | the wallet holds less than `total`; nothing is written. F-111-c offers the top-up for `missing` |
| `404 errors.billing.invoice.variantNotFound` | the variant was switched off since the invoice: the Grant cannot be issued and the whole payment rolls back |

**One transaction, in this order** (spec §5.8 step 2):

| # | Step | Why this way |
|---|---|---|
| 1 | the invoice row `SELECT … FOR UPDATE`, scoped to the caller's user | the spec's "advisory lock on the invoice", as a row lock so the expiry sweep's guarded flip waits on the same lock. Concurrent pays queue here and every one after the first reads `paid`: **exactly once** |
| 2 | the wallet row `FOR UPDATE` | the ledger's version guard then cannot lose to a writer that read the balance first |
| 3 | `total <= cachedBalance`, else `insufficient_balance` | a user with no wallet has a balance of zero |
| 4 | one debit of `total`, `reasonType: product_purchase`, `referenceId` = the invoice — skipped when `total` is `0` | invariant 2: a ledger amount is > 0, so a free invoice writes no row |
| 5 | invoice → `paid` | — |
| 6 | `GrantService.issue`, `source: purchase`, `sourceReferenceId` = the invoice, `startsAt` = now | a purchase starts `pending` (entitlement contract); delivery (F-111-d) activates it. The `(source, sourceReferenceId)` unique index is the second line against a double issue |
| 7 | `CouponReservationService.confirm(invoiceId)` | the holds step 1 took become uses |
| 8 | `outbox_event` `entitlement.grant.created`, aggregate `entitlement.grant` | ADR-0021; payload `{tenantId, userId, grantId, variantId, status, source, invoiceId, total}`. No consumer yet: the relay records it `unroutable` until delivery binds one |

Per user, `INVOICE_PAY` bucket, `INVOICE_PAY_RATE_LIMIT` (20) per 15 min. It
bounds the transactions one caller opens on the wallet row; exactly-once does
not rest on it.
