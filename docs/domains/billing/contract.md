---
id: billing
layer: domain
status: active
version: 8
updated: 2026-09-20
---

# Contract — billing

**Nine things built** — the wallet credit/debit primitive (F-092-b), the
gateway pricing calculator (F-092-e), the payment provider port (F-092-f),
coupon validation (F-092-g) and coupon reservation (F-092-h), all below, one
whole top-up — the gateway list and quote (F-092-o), starting the payment
(F-092-i) and the callback that settles it (F-092-j) — in
**[contract.deposit.md](contract.deposit.md)**, and the wallet history +
payment attempt routes (F-092-n) in
**[contract.history.md](contract.history.md)** (both §10), and the invoice for buying a catalog product
(F-111-a) in **[contract.purchase.md](contract.purchase.md)**. Every other row in *Provides* is still intent from
`txnet-backend/prisma/domains/billing.prisma`.

## Gateway management (built — F-102-b/c, F-102-f-b, F-066-w3, D-31)

Creating, changing and deleting a gateway, and a top-up page's quick amounts:
`/api/billing/gateways` for a tenant configuring itself, and
`/api/billing/tenants/:tenantId/gateways` for the reseller a path names.
One set of rules, in **[contract.gateways.md](contract.gateways.md)** (§10).

## Coupon reservation (built — F-092-h)

`CouponReservationService.reserve(tx, {userId, orderReferenceId, paymentTransactionId?, applied})`,
`.confirm(tx, orderReferenceId)`, `.release(tx, orderReferenceId, 'cancelled' | 'expired')` in
`billing-service/src/app/payment/coupon/coupon-reservation.ts`, over the SQL functions of migration
`20260911000200_coupon_reservation`; `deposit/start` reserves and, on its free path, confirms (F-092-i);
the callback confirms (F-092-j) and F-092-k expires the rest.

| Rule | Why |
|---|---|
| `reserve` writes one `pending` `coupon_redemption` and `reservedCount + 1` per applied coupon, taking coupons in id order | two orders stacking the same codes never deadlock |
| Under a row lock on the coupon it re-checks active / visible / targeted, `wallet_credit`, expiry, per-user (`pending` + `confirmed`, `0` unlimited) and `usedCount + reservedCount < totalUsageLimit` | invariant 6; legacy's count-then-upsert gave the last slot twice (`coupon-reservation.int.spec.ts`) |
| Scope and minimum purchase are not re-checked — they are validation's, on the same request | they do not move with other buyers |
| A coupon that can no longer be held is `CouponReservationRefused {code, reason}` (a `CouponRejection`); it wrote nothing, the holds before it did — the caller's transaction must abort and re-quote | a partial set of holds must never commit |
| `confirm` moves the order's `pending` rows to `confirmed`, `reservedCount - n`, `usedCount + n`; `release` to `cancelled` / `expired`, `reservedCount - n`. Only `pending` moves: a repeat answers `0`, a confirmed use is never given back | duplicate callback, late expiry |
| A hold has no clock of its own; it lives as long as its payment (F-092-k expires both) | legacy's 20-minute lock TTL goes |
| Runs in the caller's `tenantTransaction`, else `TenantScopeConflict`; a coupon of another tenant is `not_found` | the functions scope by `app.tenant_id` |
| A platform coupon's counters move only through these functions; whose users it serves is [contract.coupon.md](contract.coupon.md) | ADR-0040, ADR-0048 |

## Coupon validation (built — F-092-g)

`CouponValidationService.validate(tx, {codes, amount, target, userId})` and the pure
`applyCoupons` in `billing-service/src/app/payment/coupon/coupon-validation.ts`; the deposit
quote calls it (F-092-o) and `deposit/start` reserves what it applied (F-092-i). Reserves nothing.

| Rule | Why |
|---|---|
| Codes are trimmed, upper-cased, blanks dropped, de-duplicated; a stored `coupon.code` must be upper-case — the admin writer normalises | legacy behaviour kept; the lookup is exact |
| Applied in the order typed, each on what the previous left (60% then 50% of 20 = 12 + 4); `totalDiscount` is the calculator's `discount` | D-21, D-23 |
| A percentage is rounded **down** to the cent, then capped by `maxDiscountCap`; any discount is capped at the running payable | never give away an unrounded cent |
| A failing code is `rejected` with a closed `reason` and takes nothing; the route maps `reason` to an i18n key (C-01) | the codes after it see the untouched payable |
| Gates, in order: inactive / soft-deleted / targeted at someone else → `not_found`; `wallet_credit` → `not_a_discount` (F-092-m); a platform coupon on a tenant gateway → `platform_coupon_needs_platform_gateway` (F-502-b); then F-502-k's limits interleaved as [contract.coupon.md](contract.coupon.md) lists; `expiresAt <= now` → `expired`; scope; `minPurchaseAmount` against the **amount**; per-user; capacity | legacy order |
| Scope: no `coupon_service_scope` row is open; a top-up matches no scoped coupon; a plan matches a row naming the plan or its category | schema comment |
| Per-user: the user's `pending` + `confirmed` redemptions `>= perUserUsageLimit` refuses — the user's own unfinished hold counts; a limit of `0` is unlimited | invariant 6; `0` answered by the user 2026-09-11, as in legacy |
| Capacity: `usedCount + reservedCount >= totalUsageLimit` refuses; `null` is unlimited. Advisory — F-092-h takes it atomically | the count here can be stale by the time of reserving |
| A code whose discount comes to zero is `nothing_to_discount`, not applied at zero | legacy applied it and spent a use on nothing |
| Read in the caller's `tenantTransaction`, else `TenantScopeConflict`. `coupon` stays out of `TENANT_SCOPED_MODELS`: its shared-read RLS policy (own, or a platform coupon that serves the tenant — ADR-0048) is the scope | the extension would hide the platform's coupons; `coupon-validation.int.spec.ts` |
| A broken coupon row (percentage outside (0, 100], fixed <= 0) or an amount <= 0 / finer than a cent is `InvalidCouponInput` | refused, never clamped |

## Payment providers (built — F-092-f)

`PaymentProviderRegistry.get(providerName)` / `.has(providerName)` and `GatewayMerchant.credentialsFor(config, actorId?)`
in `billing-service/src/app/payment/gateway/`; the deposit quote (F-092-o), `deposit/start` (F-092-i) and the callback that verifies (F-092-j) call them.

| Rule | Why |
|---|---|
| A driver answers `request` → `{authority, redirectUrl}`, `verify` → `{referenceId, cardPan, alreadyVerified}` (optional `deadlineAt`, F-092-ab), `inquire` → `{status}`, `quoteFee` → `{feeMinor}`, and — when its gateway can list them — `listUnverified` → `[{authority, amountMinor, callbackUrl}]` (F-092-ad) | legacy `IPaymentStrategy`, minus its settings row |
| A driver names `chargeCurrency` and `chargeDecimals` — Zarinpal `IRR`, `0`; Stripe `USD`, `2` — which the caller hands the calculator | the minor unit is the wire's, not a money rule |
| Amounts cross the port as `bigint` in the gateway currency's minor unit — `chargedAmountMinor`; Zarinpal is sent `IRR`. `feeMinor` is converted to base currency by the caller, with the rate, before it is `quotedFee` | a driver holds no rate and no money rule |
| `request` is **never retried**; `verify`, `inquire`, `quoteFee` are retried on a transport failure only (timeout, network, 5xx), 3 attempts | each `request` mints an authority; an answer does not change on a retry |
| Zarinpal `verify`: `100` and `101` are both success, `101` is `alreadyVerified` | the legacy bug on the row |
| A failure is `GatewayFailure` with a closed `reason` and the provider's code; the route that first exposes one maps `reason` to an i18n key (C-01) | as for the ledger and the calculator |
| `unavailable` means the outcome is unknown, not that the payment failed | reconciliation (F-092-l) settles it |
| Sandbox is `PAYMENT_GATEWAY_SANDBOX`, per environment; the boot refuses it with `NODE_ENV=production`. **Zarinpal's `quoteFee` goes to production in every environment** — the sandbox has no `feeCalculation` route (404), so an automatic fee could never be quoted there (the user's call, 2026-09-14) | a sandbox "verify" would credit money that never moved |
| **Every gateway has its own merchant account** (changed in v4): the vault's `gateway_merchant_id` of the gateway's tenant, `label` = `gateway:<source>:<gatewayId>` (`tenant` for a `tenant_gateway_config` row, `platform` for a `payment_gateway` row), read by `vault.use` with `caller: billing:<provider>` on every call and kept by nobody. No fallback to a provider-wide label; a recreated gateway row stores its merchant id again | D-26; ADR-0026, ADR-0039; `gateway-merchant.int.spec.ts` |
| The vault reads run on the app pool bound to the request's tenant — a config of another tenant is `CredentialUnavailable('missing')` | ADR-0039; `gateway-merchant.int.spec.ts` |
| A platform-brand `payment_gateway`'s merchant id is in the `platform_owner` tenant's vault under its own `gateway:platform:<id>` label; the plaintext `merchantId` column is deprecated and never read | D-25, D-26 |
| A gateway missing any secret its provider declares (`provider-fields.ts`) can take no payment, so it is not offered (`configuredSecrets` + `hasEverySecret` / `requireConfigured`, F-092-u). `credentialsFor` reads the provider's own secrets — Zarinpal a merchant id, Stripe a secret key — never the webhook secret (F-104-g) | a gateway a user can pick and not pay at is worse than one they cannot see; a Stripe gateway has no merchant id |
| **Stripe** (F-104-g, `stripe.provider.ts`, official SDK): Checkout Session per `request`, client built per call from the gateway's key; `constructEvent` checks the post. `checkout.session.completed` + `paid` = paid (unpaid = pending), `.expired` = failed, **`payment_intent.payment_failed` ignored**; a delayed method (ACH, SEPA) settles later, so `.async_payment_succeeded` is read like `completed` and `.async_payment_failed` fails the row (F-104-y); `inquire`/`verify` retrieve the session; `quoteFee` refused (`invalid_request`) — price it with a manual fee | Checkout retries a declined card on the same page: failing the row on the first decline would leave the paying retry nothing to credit. A debit the payer left the page for has no such retry, and waiting for expiry flags settled money for a person |

## Gateway pricing (built — F-092-e)

`priceAtGateway(request)` and `feeBasis(request)` in
`billing-service/src/app/payment/pricing/gateway-pricing.ts`, reached by both
deposit routes through the shared `deposit/deposit-pricing.ts` (F-092-o,
F-092-i), so the quote and the charge cannot be computed differently. The worked
numbers are `gateway-pricing.golden.json` (F-0611).

| Rule | Why |
|---|---|
| The quote shown and the amount charged both come from `priceAtGateway`; nothing else does money arithmetic on a deposit | F-0612 — legacy clamped a quoted fee on one path only |
| Pure: the provider's fee quote and the FX rate are arguments. The caller asks the provider for `feeQuoteAmountMinor(request)` and passes `quotedFeeFromMinor(request, feeMinor)` (cents up); the staleness ladder decides whether a `liveRate` is passed | F-0610; F-0607 needs a clock |
| Order: `amount` in `[minAcceptAmount, maxAcceptAmount]` → minus `discount` → gap → fee → tax → `payable = basis + fee + tax`; `credited = amount + gap`. Either bound may be `null` — no limit on that side, and no gap without a minimum (migration `20260914000800`) | F-092-o's quote shape; the user's call, 2026-09-14 |
| **Tax on a top-up** (v37, reversing v3): `tax` is the gateway's `taxRatePercent`, else the caller's `deposit_setting` default, of the basis (not of the fee), added on top and rounded **half-up** to the cent once; `taxRatePercent` in the result is the rate used, `null` = none. A rate outside 0..100 is `InvalidPricingInput` | ADR-0076: tax is remitted, so it is never rounded up like the fee |
| Gap: a remainder above zero and under the minimum is raised to it, and the difference is credited too | legacy behaviour kept |
| A percentage fee is taken on that remainder (after discount and gap) | the fee follows what reaches the gateway |
| Remainder zero is the free path: no fee, tax, rate or quote; `chargedAmountMinor = null` | nothing reaches the gateway |
| A `discount` above `amount` is `InvalidPricingInput`, not a free deposit | the coupon engine (F-092-g) caps stacking |
| `feeFloor` / `feeCeiling` bind a quoted fee exactly as they bind a manual one | the legacy bug named on the row |
| Cents round **up**; the rate rounds to `roundingStep` up or nearest (half up); `chargedAmountMinor` rounds up | F-0609 — never down |
| Rate = (`liveRate` if `useLiveRate`, else or if absent `staticRate`) × (1 + `percentageModifier`/100) + `fixedAmountModifier`, then rounded; a missing or non-positive source is `RateUnavailable`. A driver charging the base currency (`USD`: Stripe) prices at **exactly 1**, no rate column applied (`chargesInBaseCurrency`, F-104-g, the user's call) | F-0607's last rung disables the gateway |
| A rounded rate outside `[minRate, maxRate]` is `RateOutOfRange` — refused, never clamped | F-0607: a wrong rate costs an unbounded amount |
| Errors are plain classes with English messages (C-01); the route that first exposes one maps it to an i18n key | as for the ledger |

## Payment and coupon storage (built — F-092-d)

`deposit/start` is the first writer of `payment_transaction` (F-092-i). Migration
`20260911000000_payment_legacy_port`, proved by
`billing-service/src/app/payment/payment-schema.int.spec.ts`.

| Rule | Why |
|---|---|
| A `payment_transaction` names exactly one gateway: `gatewayId` (platform brand) or `tenantGatewayConfigId` (a reseller's own) — a CHECK | ADR-0006: a reseller's gateway is never a `payment_gateway` row |
| `gatewayTrackingCode` is unique per gateway column; for Zarinpal it holds `authority`, not `ref_id` (`gatewayReferenceId`) | ADR-0028 — `authority` is what a duplicate callback shares |
| A payment's coupons are its `coupon_redemption` rows; there is no `couponId` column | codes stack, applied in order, each on what the previous left (D-21) |
| `perUserUsageLimit` may exceed 1 and is **not** enforced by an index — the redemption transaction counts it | D-21; F-092-h |
| Amounts are base currency; `chargedAmountMinor` + `exchangeRateSnapshot` are what the gateway was asked for, frozen at intent | ADR-0019 |
| `amountReceivedMinor` + `receivedCurrency` are what the gateway reports **arrived** — a receipt, never money of record: both or neither (CHECK), amount `>= 0`, code `^[A-Z0-9]{2,20}$`, in that currency's minor unit. Migration `20260916000200_payment_d32_providers_and_receipt` also adds D-32's providers and `GatewayCategory.in_chat` | D-32; C-02's one exception (F-104-a) |
| `taxApplied` (`>= 0`, default 0) + `taxRatePercent` (0..100, null = no tax) are what a top-up was taxed and at which rate, frozen at intent so a later rate change cannot re-explain the receipt. No rate means `taxApplied = 0` (CHECK); rows before F-104-ae read 0 and null. Migration `20260924001300_tax_on_top_up_returns` | ADR-0076 (F-104-ae) |
| `exchangeRateSnapshotId` says **which** reading that rate was — a FK to `currency.currency_exchange_rate`, `RESTRICT`, null on a `staticRate` gateway. The FX worker appends a row per accepted poll, so the number alone identifies nothing | F-0606-b |
| `displayName` and gateway pricing (fee / min / max, and F-0609's rate columns, and `taxRatePercent` — null = the tenant's default, ADR-0076) have the same columns on `payment_gateway` and `tenant.tenant_gateway_config` | one calculator reads both (F-092-e) |

## Request edge (built — F-092-a)

| What | Where |
|---|---|
| Every route is under `/api/billing/*`, published by Traefik behind `strip-fake-headers,my-auth` — the required gate. **Two exceptions:** `deposit/webhook/*` (F-104-b, ADR-0051, same shape) and `deposit/callback`, published with `strip-fake-headers` alone, on a higher-priority router with no `Host(...)`, because a bank redirects a browser to whichever tenant's panel domain it was minted on (F-092-j) | `dev-docker/docker-compose.main.yml` |
| A request without `X-User-Id`, `X-Tenant-Id`, `X-Role-Id` and `X-Session-Id` is refused **401** — never served with no tenant, never with half a set. `X-User-Permissions` may be empty or absent: an empty list | `billing-service/src/app/request/identity.middleware.ts` |
| The handler runs inside `runWithTenant({ id: X-Tenant-Id })`; `identityOf(req)` returns the rest | same file |
| On the public callback there are no headers to read, so `CallbackTenantMiddleware` resolves the tenant from the **Host** against `tenant_domain` and opens the scope itself; an unknown or unproven host is a neutral **404** (ADR-0025). A middleware and not a guard — the rate limiter counts on the tenant in context | `billing-service/src/app/request/callback-tenant.middleware.ts` |
| Queries go through `PrismaService` on `DATABASE_APP_URL` with `withTenant` applied. Since F-092-j there is a **second** pool, `CrossTenantPrismaService` on `DATABASE_CROSS_TENANT_URL`, held by the callback middleware alone: that read is what *produces* a tenant, so it cannot run inside one. It is a policy (`USING (true)`), never a bypass — neither role holds `BYPASSRLS` — and `grep -rn CrossTenantPrismaService` is the audit | `billing-service/src/app/prisma/prisma.module.ts` |
| Success and errors use the `shared-core` envelope, translated per `Accept-Language` | `billing-service/src/main.ts` |
| **CORS is on for `FRONTEND_ORIGIN`, with credentials** (added F-093-c): since ADR-0060 the panel calls these routes same-origin, at `/api/billing` on its own domain, so CORS now serves only a caller that is really cross-origin. A missing origin is a refusal to boot when `NODE_ENV=production` — never "allow any origin"; the permissive fallback is dev-and-localhost only. This service was built asserting the panel used a same-origin proxy, which `panel-web` had already deprecated (`panel-web/contract.md`), and no caller existed to make that wrong visible | `billing-service/src/main.ts` |
| Every route but `health` carries `@RateLimit`, enforced by the global `RateLimitGuard` (the `shared-core` limiter, counted in Redis, F-092-r), bucketed on the caller's `userId` — except the public callback, which has no caller and counts the **payment** (F-104-u). A new route without one, or a gated one bucketed on anything but its caller, fails `request/rate-limit-coverage.spec.ts`; over the limit is **429** `system.rateLimit` | `billing-service/src/app/app.module.ts` |
| `GET /api/health` bypasses the identity check and is not published by Traefik | `billing-service/src/app/health.controller.ts` |

## Wallet ledger (built — F-092-b)

`WalletLedgerService.credit(tx, entry)` / `.debit(tx, entry)` in shared-core
`lib/billing/wallet-ledger.ts` (ADR-0061; billing's old path re-exports it); the gift box
(F-092-m), a fully discounted top-up (F-092-i), the gateway callback (F-092-j), and
`tenant-service`'s reseller purchase (F-019-h, `reseller_purchase`) call it.

| Rule | Why |
|---|---|
| Takes the caller's `tx`, which must come from `tenantTransaction(prisma, fn)`; `walletTransaction` is a registered model, so any other transaction is refused — except a cross-tenant pool's, whose caller names `entry.tenantId` | the balance and the reason it moved commit together (`tenant-context` rule 5) |
| `entry.userId` must come from a tenant-scoped source — `X-User-Id`, or a row read under the scope | `wallet` has no `tenantId`; the ledger row is stamped with the tenant in scope |
| `amount` is base currency, `> 0`, at most 2 decimal places; anything else is `InvalidLedgerAmount`, never rounded | invariant 2; `Decimal(18, 2)` would round the amount but not `balanceAfter` |
| `cachedBalance` is updated with `where { id, version }` **before** the row is appended; `count = 0` is `WalletVersionConflict` | invariants 1, 4 — a loser appends nothing |
| A lost race is thrown, not retried; the caller restarts its whole transaction | a retry inside the same transaction cannot read the row fresh |
| A debit below zero, or from a user with no wallet, is `InsufficientFunds` | a missing wallet is a zero balance |
| A first credit opens the wallet (`createMany … skipDuplicates`) | two first credits meet at the version guard, not at the unique `ownerUserId` |
| Returns the appended `wallet_transaction`, whose `balanceAfter` is the new balance | — |
| A credit to a **user's** wallet is written through `WalletCreditService.credit` (`wallet/wallet-credit.service.ts`), not the ledger directly: it appends the row and then revives the Grants that balance funds, in the same transaction (F-027-ap, ADR-0079). The four callers are the gateway settlement, the free top-up, a gift redemption and the remainder credit; a fifth that calls the ledger instead fails `entitlement/revival.spec.ts`. A **debit** still calls the ledger — nothing a debit does revives anything — and so does `TenantBillingLedger`, a different wallet with no Grant | a balance the user can see while their service is still off is a support ticket |

The errors are plain classes with English messages (C-01); the route that first
exposes one maps it to an i18n key.

## TL;DR

One `Wallet` per user; `cachedBalance` is a cache, `WalletTransaction`
(append-only) is the truth (ADR-0002). Payments come in through a
`PaymentGateway` (platform brand only) with two confirmation defences (webhook +
reconciliation worker) plus manual admin fallback. Coupons use a two-phase
reserve/confirm state machine (built, F-092-h).

## Provides (intended)

| Operation | Input | Output | Sync/Async | Errors |
|---|---|---|---|---|
| credit / debit wallet — **built**, see above | tx, userId, amount, reasonType, referenceId | `wallet_transaction` + new `balanceAfter` | sync tx | insufficient funds, version conflict, invalid amount |
| quote a deposit + list gateways — **built**, [contract.deposit.md](contract.deposit.md) | userId (header), gatewayId, amount, couponCodes[] | selectable gateways; the price breakdown + rejected codes | sync, read | gateway not found, amount out of range, gateway unavailable |
| read the wallet history — **built**, [contract.history.md](contract.history.md) | userId (header), type / direction / date / search filters, page | the ledger page with its `balanceAfter` column and the wallet balance; separately, the payment attempts | sync, read | — |
| price a deposit — **built**, see above | gateway pricing, amount, discount, quotedFee?, liveRate?, chargeDecimals | base, discount, gap, fee, payable, credited, rate, chargedAmountMinor | sync, pure | invalid input, amount out of gateway range, fee quote required, rate unavailable / out of range |
| start a top-up — **built**, [contract.deposit.md](contract.deposit.md) | userId (header), gatewayId, source, amount, couponCodes[] | the payment id + the gateway's redirect URL, or a credited wallet on the free path | sync | gateway not found, amount out of gateway range, coupon hold refused, gateway unavailable |
| confirm payment | gateway webhook / reconciliation / admin | wallet credit + `payment_transaction.status = success` | async | duplicate, mismatch (flagged) |
| initiate wallet transfer | senderId, receiverId, amount | `wallet_transfer_request` (`pending_otp`) | sync | — |
| confirm wallet transfer | transferId, OTP | atomic debit+credit, `confirmed` | sync tx | bad/expired OTP (5 tries -> cancelled) |
| validate coupons — **built**, see above | tx, codes[], amount, target, userId | applied (couponId, code, discount), rejected (code, reason), totalDiscount, payable | sync, read | invalid input, scope conflict |
| reserve coupons — **built**, see above | tx, userId, orderReferenceId, paymentTransactionId?, applied[] | `coupon_redemption` rows (`pending`) | sync tx | refused (reason), invalid input, scope conflict |
| confirm / release coupons — **built**, see above | tx, orderReferenceId, outcome | count moved to `confirmed` / `cancelled` / `expired` | sync tx | scope conflict |
| create an invoice — **built**, [contract.purchase.md](contract.purchase.md) | userId (header), variantId, couponCodes[] | invoice priced from the catalog, coupons held, 30-min expiry | sync | variant not for sale, coupon hold refused |
| accrue affiliate commission | triggering paymentId | `affiliate_commission` (`pending`) | async | — |

## Emits (events)

Through the outbox (ADR-0021). `entitlement.grant.created` — a paid invoice's
Grant, `pending` (F-111-b, [contract.purchase.md](contract.purchase.md)); no consumer yet.
Its delivery's `entitlement.grant.delivered` / `.refunded` are entitlement's (F-111-d).

## Consumes

| From unit | What | Failure behaviour if unavailable |
|---|---|---|
| identity | `ownerUserId`, transfer sender/receiver, OTP for transfer confirm | transfer/credit blocked |
| catalog | a coupon scope's `productId` / `variantId`, and a `free_grant` coupon's `grantVariantId` (F-026-a, D-35); the variant's price in effect, for an invoice (F-026-c, `sellableOfferById`, F-111-a) | coupon scope check fails; a free-service code is refused `variant_not_found` |
| entitlement | `GrantService.issue` inside the gift redemption's transaction, `source = coupon` (F-502-l-b, ADR-0049), and inside an invoice's payment, `source = purchase` (F-111-b) | the redemption rolls back; the code stays unused |
| currency | base-currency amounts only in; display conversion is currency's job | — |
| tenant | `tenantId` denormalized on `wallet_transaction` / `payment_transaction` for reporting | — |
| tenant | the request tenant's `tenant_domain` rows — the `panel` host a gateway callback comes back to, proven custom domain first, never a CNAME target (`isCnameTarget`, ADR-0060 (6)) (F-092-i, ADR-0020). Read under RLS in its `tenantTransaction`; never a request header | no host to answer on: starting a payment is refused 503 |
| tenant | the request tenant's `tenant_gateway_config` rows — pricing and provider, never the secret columns — read under RLS in its `tenantTransaction` (F-092-o); `tenant.tenantType`, to offer `payment_gateway` to the `platform_owner` alone (F-092-s) | no gateway to offer: the list is empty |

## Guarantees (intended)

- All amounts are base-currency `Decimal`, always positive; direction is
  `credit` / `debit` (ADR-0002).
- Balance mutation = one Postgres transaction: append ledger row (with
  `balanceAfter`) + bump `cachedBalance` + `version`.
- Payment confirmation is idempotent across webhook / reconciliation / admin
  (`confirmationSource`); a mismatch is `flagged_mismatch`, never auto-reversed.
- `perUserUsageLimit` is counted when a coupon is reserved, inside the payment
  transaction — **changed in v2**: it was a DB unique `(couponId, userId)` that
  capped every coupon at one use per user (D-21).
- `exchangeRateSnapshot` is frozen at intent time, never recomputed — on crypto
  and on the rial/card path (ADR-0019) — and since F-0606-b it is frozen
  together with `exchangeRateSnapshotId`. `priceAtGateway` returns the pair:
  the rate it charged at, and the `currency_exchange_rate` row that rate was
  derived from, or neither when the gateway priced from its own `staticRate`.
  A live rate handed to it without a snapshot id is a caller bug, not a quiet
  fall back — the state ADR-0019 says the rial path must never be in.

## Deprecations

| Item | Deprecated since | Removal after | Replacement |
|---|---|---|---|
| `payment_gateway.merchantId` (never read) | 2026-09-11 | once a platform gateway's merchant id is in the vault in every environment | the `platform_owner` tenant's vault `gateway_merchant_id`, `gateway:platform:<id>` (D-25, D-26) |
