---
id: billing
layer: domain
status: active
version: 5
updated: 2026-09-25
---

# Contract — billing / purchase

A topic file of `contract.md` (§10): buying a catalog product from the wallet
(spec §5.8 Purchase Settlement Flow — `python3 tools/spec.py --section 5.8`).
Step 1, the invoice, is built (F-111-a), step 2, paying it from the wallet
(F-111-b), the shortfall a refused payment carries (F-111-c, spec §5.9), and
step 3, delivery and the refund of what could not be delivered (F-111-d), and
the two reads the panel's shop page needs (F-111-e), and the discounts with
no code an invoice is priced with (F-114-h, ADR-0087). Consumer: that page,
`panel-web/contract.shop.md`.

## Creating an invoice (built — F-111-a)

`POST /api/billing/invoices` — `InvoiceController` + `InvoiceService` in
`billing-service/src/app/invoice/`, proved by `invoice/invoice.spec.ts`. Behind
the gate like every billing route ("Request edge" in `contract.md`).

| Body | Answer (201) |
|---|---|
| `variantId` (uuid), `couponCodes?` (≤ 10, ≤ 64 chars each) | `{id, variantId, sku, nameKey, status: "pending", amount, discount, total, automaticDiscount: {ruleId, name, discount} \| null, applied: [{code, discount}], rejected: [{code, reason, message}], expiresAt}` — money as decimal strings, base currency (C-02) |

| Rule | Held by |
|---|---|
| **The server prices it.** `amount` is the catalog price row in effect now, in USD; the body has no price field, and one sent (`price`, `amount`, `total`) is stripped by the schema — ignored, not validated (spec §5.8) | `invoiceCreateSchema` (not strict), `InvoiceCreateRequest` has no price |
| For sale to **this** tenant, or a neutral `404 errors.billing.invoice.variantNotFound`: live variant, product and category; `public` or `unlisted` (a direct link is a way to buy); a price in effect; RLS returns only the tenant's own variants and the platform's | `sellableOfferById` (catalog's rules, `offers.ts`) |
| The tenant's status: `@TenantCapability('sell')` — suspended, terminated or onboarding sells nothing (`403`) | `TenantStatusGuard` |
| **A discount with no code first** (F-114-h, D-45): the one matching rule that takes the most ("Discounts with no code" below). `discount` = the rule's part + the coupons'; the row records `discountRuleId` and `ruleDiscount` | `discountRuleFor` (`invoice/discount/discount-rule.ts`) |
| Coupons are validated against this variant and its product (`target: purchase`), **on what the rule left**, with the discount engine's order and gates ([contract.md](contract.md) "Coupon validation"). A code that fails is in `rejected`, with its i18n message, and the invoice is made without it — the shopper removes it or buys | `CouponValidationService` |
| The applied codes are **held** under the invoice's id (`orderReferenceId`), in the same transaction as the row. A hold that can no longer be taken is `409` with the code's reason, and nothing is written | `CouponReservationService.reserve` |
| A free variant (price `0`), or one a rule took whole, asks no coupon engine; every code typed is `nothing_to_discount` | `InvoiceService.create` |
| `total = amount - discount`, `0 <= discount <= amount`, `amount >= 0` — CHECKs; `priceId` names the price row used | migration `20260925000400_invoice` |
| `expiresAt` = creation + 30 minutes (`INVOICE_TTL_MS`) | `InvoiceService.create` |
| Per user, `INVOICE_CREATE` bucket, `INVOICE_CREATE_RATE_LIMIT` (20) per 15 min | `@RateLimit` |
| **Only what can be delivered is sold** (F-111-d): a kind with no delivery handler — `external_order` (retired until a real provider exists — F-111-h), `wallet_topup` (retired, never built: no new product of it is created — F-111-g; money comes in through the deposit page only), a `network_access` variant with no panel group — is the same neutral `404 variantNotFound` | `deliveryRouteOf` (entitlement `delivery.ts`); the user's call 2026-09-25 — a paid Grant nothing can deliver could only be refunded |
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
| `409` `reason`: `already_paid` / `expired` / `cancelled` | its i18n key beside it. Past `expiresAt` is `expired` even before the sweep flips it. A `refunded` invoice (F-111-d) is `already_paid`: it was, and its clock may still run |
| `409 insufficient_balance` + `error.facts: {total, balance, missing}` | the wallet holds less than `total`; nothing is written. `missing` is the top-up to offer — "The shortfall" below. In `facts` because the shared envelope drops any other field (F-111-e: until then the figure never reached a client) |
| `404 errors.billing.invoice.variantNotFound` | the variant was switched off since the invoice: the Grant cannot be issued and the whole payment rolls back |

**One transaction, in this order** (spec §5.8 step 2):

| # | Step | Why this way |
|---|---|---|
| 1 | the invoice row `SELECT … FOR UPDATE`, scoped to the caller's user | the spec's "advisory lock on the invoice", as a row lock so the expiry sweep's guarded flip waits on the same lock. Concurrent pays queue here and every one after the first reads `paid`: **exactly once** |
| 2 | the wallet row `FOR UPDATE` | the ledger's version guard then cannot lose to a writer that read the balance first |
| 3 | `total <= cachedBalance`, else `insufficient_balance` | a user with no wallet has a balance of zero |
| 4 | one debit of `total`, `reasonType: product_purchase`, `referenceId` = the invoice — skipped when `total` is `0` | invariant 2: a ledger amount is > 0, so a free invoice writes no row |
| 5 | invoice → `paid` | — |
| 6 | `GrantService.issue`, `source: purchase`, `sourceReferenceId` = the invoice, `startsAt` = now | a purchase starts `pending` (entitlement contract); delivery (below) activates it. The `(source, sourceReferenceId)` unique index is the second line against a double issue |
| 7 | `CouponReservationService.confirm(invoiceId)` | the holds step 1 took become uses |
| 8 | `outbox_event` `entitlement.grant.created`, aggregate `entitlement.grant` | ADR-0021; payload `{tenantId, userId, grantId, variantId, status, source, invoiceId, total}`. No consumer yet: the relay records it `unroutable` until delivery binds one |

Per user, `INVOICE_PAY` bucket, `INVOICE_PAY_RATE_LIMIT` (20) per 15 min. It
bounds the transactions one caller opens on the wallet row; exactly-once does
not rest on it.

## What the shop reads (built — F-111-e)

Both on `InvoiceService`, proved by `invoice/invoice.spec.ts`.

| Route | Answer | Rule |
|---|---|---|
| `GET /api/billing/offers` (`OffersController`) | `[{variantId, sku, nameKey, productId, productNameKey, descriptionKey, categoryKey, categories: [{key, nameKey}], fulfilmentKind, durationDays, billingMode, quotas, price}]`, by SKU. `nameKey` is the variant's own, else its product's; `productNameKey` always the product's; `categories` every **live** category the product is filed in, by its own order (F-114-d) | `forSale`: catalog's `listOffersIn` (listed, live, priced), **less what `deliveryRouteOf` cannot deliver** — the rule `create` refuses with, so the list never offers a buy that answers `variantNotFound`. `@TenantCapability('sell')`; `SHOP_OFFERS` bucket, `SHOP_OFFERS_RATE_LIMIT` (120) per 15 min |
| `GET /api/billing/invoices/:id` | the create answer without `rejected`; `applied` = the holds under the invoice's id, `pending` or `confirmed` | `get`: scoped to the caller's user (+ RLS) — unknown, another tenant's and another user's are one `404 notFound`. A `pending` one past `expiresAt` reads `expired`, as the pay refuses it. No capability (it sells nothing); `INVOICE_READ` bucket, `INVOICE_READ_RATE_LIMIT` (120) per 15 min |

## Giving an invoice up (built — F-114-d)

`POST /api/billing/invoices/:id/cancel` — `InvoiceService.cancel`, proved by
`invoice/invoice.spec.ts`. The shop replaces its invoice when the codes change;
a code held by the old one counts as a use (`per_user_limit_reached` counts
`pending` holds) until released, so the old one is cancelled first.

| Rule | Held by |
|---|---|
| The caller's own `pending` invoice -> `cancelled`, guarded by `status = pending` like the sweep; its holds released `cancelled` in the same transaction. One lapsed but not yet swept is cancelled too | `updateMany` + `CouponReservationService.release` |
| `cancelled` or `expired` already: `200` with that status — it holds nothing, so there is nothing to refuse | `cancel` |
| `paid` / `refunded`: `409 already_paid` (the pay's key); unknown, another user's or tenant's: `404 notFound`. A pay holding the row lock first makes the flip match nothing | `InvoiceNotCancellable` |
| No capability (it sells nothing); `INVOICE_CANCEL` bucket, `INVOICE_CANCEL_RATE_LIMIT` (60) per 15 min — one per create, near enough, on a budget of its own | `@RateLimit` |

## The shortfall (built — F-111-c)

`invoiceShortfall` in `invoice/invoice-shortfall.ts`, proved by
`invoice/invoice-shortfall.spec.ts` against the deposit pricer itself.

| Rule | Why |
|---|---|
| `missing` = `total - balance` rounded **up** to the cent — never half-up — and only for a balance short of `total` | spec §5.9: the user must never come back from a top-up a fraction of a cent short. Every column is `Decimal(18, 2)` today, so this is exact now and stays right if a balance ever carries more places |
| `missing` has at most 2 places | a deposit `amount` takes at most 2 (`deposit.schema.ts`, `priceAtGateway`); a longer one would be refused |
| A top-up of exactly `missing` covers the invoice | a top-up credits `amount + gap`; fee and tax are on top of it, never taken from it (`contract.deposit.md`) |
| The panel pre-fills `missing` raised to the chosen gateway's `minAmount` (the gateway list), and returns to the same invoice (F-111-e) | below its minimum a gateway refuses the top-up `400 billing.amountOutOfRange`, and only the panel knows which gateway the user picks; a larger top-up credits whole, so it still covers |
| The shortfall is not held: the invoice's 30-minute clock runs on while the user tops up | a top-up that outlives it pays into the wallet, and the user starts a new invoice |

## Delivering it (built — F-111-d)

Spec §5.8 step 3, and entitlement's: `GrantDeliveryService`
(`entitlement/delivery.ts`), rules in `entitlement/contract.md` "Delivery of a
paid Grant". What it means for the invoice:

| Rule | Why |
|---|---|
| Delivered: the Grant `active`, the invoice stays `paid`; `entitlement.grant.delivered` tells the buyer (inbox, bot, live) | the sale stood |
| Not delivered — no handler at the first check, or still `pending` after 6 retries at 1, 2, 4, 8, 16, 32 minutes: the Grant `cancelled`, the invoice `paid -> refunded`, one `product_refund` credit of the whole `total` (`referenceId` = the invoice), `entitlement.grant.refunded` with `amount` | the user's call, 2026-09-25. The refund is a credit like any other, so it revives what it funds (F-027-ap) |
| `product_refund` undoes a `product_purchase` in a reseller's sales (`contract.revenue.md`) and shows on `/wallet/history` (`contract.history.md`) | money back belongs where the user and the reseller see it |
| The coupon uses stay confirmed | the refund is `total`, which is what was paid |

## Discounts with no code (built — F-114-h)

ADR-0087, D-45. `discount-rule.ts` decides, proved by
`invoice/discount/discount-rule.spec.ts`; migration
`20260925001500_a_discount_without_a_code`.

| Rule | Held by |
|---|---|
| A rule is its tenant's own (strict RLS), the platform owner's included; none serves another tenant's users | `discount_rule` policies; every read and write in the caller's `tenantTransaction` |
| It covers everything, one `productId`, or one `categoryId` **and every category under it** — never both (CHECK); it serves everyone, its `discount_rule_user` rows (`forNamedUsers`), or the **user** members of one of its tenant's groups (`groupId`, F-114-j) — never named users and a group at once (CHECK); a reseller member of the platform's group is not its customers | `ruleMatches`; `discount_rule_one_audience`; `discount_rule_groupId_tenantId_fkey` (the group's `(id, tenantId)`) |
| It runs from `startsAt` to `endsAt`, the end exclusive, null = until switched off; `isActive: false` takes nothing | `ruleMatches`; `discount_rule_window_ok` |
| A percentage in (0, 100] rounds down to the cent; a fixed amount takes at most the price | `ruleDiscountOf`; `discount_rule_value_ok` |
| Of every match, the one that takes the most; a tie goes to the older rule. Rules never stack | `bestDiscountRule` |
| An invoice keeps what its rule took: an edit reaches only later invoices, and a rule an invoice names is switched off, never deleted | `invoice.ruleDiscount`; `invoice_discountRuleId_fkey` RESTRICT |
| A group a rule names is not deleted: the rule is pointed elsewhere first | `discount_rule_groupId_tenantId_fkey` RESTRICT; governance `group_in_use` |

`/api/billing/discount-rules` — `DiscountRuleController`, behind `coupon.manage`
(`CouponPermissionGuard`) and the coupon admin's `COUPON_ADMIN_READ` / `_WRITE`
budgets. Bodies are `.strict()`; money is a decimal string (C-02).

| Route | Answer | Refusals (`{reason, message}`) |
|---|---|---|
| `GET /` | every rule of the caller's tenant, newest first: `{id, name, kind, value, productId, categoryId, forNamedUsers, userIds, groupId, startsAt, endsAt, isActive, status, createdAt, updatedAt}`; `status` is `off` / `ended` / `scheduled` / `running` | — |
| `POST /` | `201` the rule. Body: `name` (≤ 80), `kind` (`percentage` / `fixed_amount`), `value`, `startsAt`; optional `productId`, `categoryId`, `forNamedUsers`, `userIds` (≤ 1000), `groupId`, `endsAt`, `isActive` | `400` `invalid_value`, `invalid_window`, `one_target`, `named_needs_users`, `one_audience` (named users and a group), `user_out_of_scope` (a user not of this tenant); `404 target_not_found` (a product or category this tenant cannot see, or archived), `404 group_not_found` (not this tenant's group) |
| `PATCH /:id` | the rule, any field of the body above; `userIds` replaces the list | the same, and `404 rule_not_found` |

Every write leaves an `admin_audit_log` row: `discount_rule_create` /
`discount_rule_update`, target `discount_rule`, the rule before and after.
