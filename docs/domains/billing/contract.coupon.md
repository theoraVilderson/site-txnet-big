---
id: billing
layer: domain
status: active
version: 2
updated: 2026-09-20
---

# Contract — billing / coupon ownership and management

A topic file of `contract.md` (§10): whose a coupon is, whose users it serves,
and what managing it may change (D-33, ADR-0048). Validation and reservation
stay in `contract.md`; the gift box in `contract.gift.md`.

## Storage (built — F-502-a)

Migration `20260914000900_coupon_management_schema`, proved by
`billing-service/src/app/payment/coupon/coupon-scope.int.spec.ts`.

| Rule | Why |
|---|---|
| A code is unique inside its tenant, and once among platform coupons, while `deletedAt` is null — two partial unique indexes | D-33: two resellers may both sell `NOWRUZ`; a deleted coupon frees its code |
| `tenantId` null is a platform coupon. It serves the tenants its `coupon_tenant` rows name; with none, the platform owner's own users only | ADR-0048 decision 2 — no longer every tenant's |
| `coupon` RLS read side: `mine OR (NULL AND billing.platform_coupon_serves(id, me))`; `WITH CHECK` stays `mine` | ADR-0048 decision 3; ADR-0040 |
| `coupon_tenant` is strict RLS: a tenant reads the rows naming it; the platform owner writes them on the cross-tenant pool | a reseller never learns whom else a coupon serves |
| `deletedAt` and `deletedByAdminId` are set together (CHECK); a soft-deleted coupon stays readable for receipts | ADR-0048 decision 6 |
| `label` and `note` are the admin's; never shown to a user | D-33 |
| `coupon_batch` groups gift codes generated together; `tenantId` null is the platform owner's, reached on the cross-tenant pool | ADR-0048 decision 7; F-502-d |
| `coupon.manage` is held by `Admin` (and `*`); the service confines a tenant to its own coupons | ADR-0048 decision 8, as `gateway.manage` (D-31) |

## Reading a coupon (built — F-502-b)

Migration `20260914001000_coupon_scope_in_functions`; `coupon-validation.ts`.
Proved by `coupon-validation.spec.ts` and the reservation, gift and scope int specs.

| Rule | Why |
|---|---|
| `reserve_coupon` and `redeem_gift_coupon` scope as the RLS read side does, and refuse a soft-deleted coupon as `not_found` | they run as owner and never see the policy |
| `settle_coupon_redemptions` / `claim_expired_coupon_redemptions` keep the old scope | a hold already taken must still give its slot back |
| Two live coupons sharing a code: the tenant's own wins (validation's `rank`; the gift function's `ORDER BY`) | ADR-0048 decision 5 |
| A platform coupon on a `tenant` gateway is `platform_coupon_needs_platform_gateway`; a granted platform gateway is `platform`. Quote and start pass `gatewaySource` | ADR-0048 decision 4 |
| A coupon never follows a lent gateway: the borrower's payer is validated in the borrower's tenant, so the lender's coupon is `not_found` there, and a platform coupon on a lent platform gateway serves the borrower only if it names it. Validation reads no grant. Proved by `coupon-validation.int.spec.ts` (F-102-f-e) | lending moves a gateway, not the lender's discounts; ADR-0041, ADR-0048 decision 2 |
| A coupon for a reseller's own account is a `targeted` coupon of whichever tenant that account lives in — F-502-c refuses any other as `user_out_of_scope` | ADR-0048 consequences |

## Limits storage (built — F-502-j)

Migration `20260914001100_coupon_limits`, proved by `coupon-limits.int.spec.ts`.
Every limit defaults to none, so an existing coupon is unchanged; F-502-k reads them.

| Column(s) | Means | Refused by a CHECK |
|---|---|---|
| `validFrom` | not before this instant (server clock) | at or after `expiresAt` |
| `activeWeekdays` | ISO weekdays in Asia/Tehran, 1 = Monday; empty = every day | outside 1..7 |
| `activeHourFrom` / `activeHourTo` | hour window [from, to) in Asia/Tehran; `from > to` wraps midnight | half set, out of 0..23 / 1..24, equal |
| `maxPurchaseAmount` | amount at most this | <= 0, or below `minPurchaseAmount` |
| `firstPurchaseOnly`, `newUserWithinDays` | the user's first purchase; an account at most N days old | N <= 0 |
| `periodUsageLimit` / `periodDays` | at most N uses per user in any D days | half set, <= 0 |
| `allowedChannels` (`panel`, `bot`) | where it may be typed; empty = anywhere | — |
| `coupon_gateway` rows | the gateways it works on; none = any. One of `gatewayId` / `tenantGatewayConfigId` | naming neither or both |

## Limit gates (built — F-502-k)

`coupon-validation.ts` (`gate`, and the loader's user, payment, period and gateway
facts); `reserve_coupon` in `20260914001200_coupon_limit_gates`. Proved by
`coupon-validation.spec.ts` and `coupon-limits.int.spec.ts`.

| Rule | Why |
|---|---|
| Full gate order: `not_found`, `not_a_discount`, `platform_coupon_needs_platform_gateway`, `not_started`, `expired`, `outside_window`, `wrong_channel`, `wrong_gateway`, `out_of_scope`, `currency_unavailable` (F-116-h6), `below_min_purchase`, `above_max_purchase`, `first_purchase_only`, `not_a_new_user`, `per_user_limit_reached`, `period_limit_reached`, `capacity_reached` | each refusal its own i18n key under `billing.coupon.*` (C-07) |
| Weekday and hour are read in Asia/Tehran from the server's instant; a window past midnight keeps the weekday it is now | the tenant market's clock; the client's is never asked |
| A channel or gateway limit with no channel / gateway named is refused | a limit is never passed by omission |
| Quote and start pass `gatewaySource`, `gatewayId` and `channel`. `channel` is `bot` only when the request carries a valid `X-Service-Token` (`presentsServiceToken`), never from the body; otherwise `panel` (F-306-a) | a body field would let any panel user spend a bot-only coupon. The bot calls through the gate like the panel, so the token is the one thing that tells them apart |
| `start` writes that channel on `payment_transaction.channel` (default `panel`, `20260916000300_payment_channel`), and `billing.payment.confirmed` carries it | the payer notice tells a `bot` payer about a webhook credit (`automation/contract.outbox.md`) |
| `newUserWithinDays` reads `identity.user.createdAt` in the caller's tenant transaction; an account not found is not new | identity is a dependency already |
| ASSUMED(2026-09-14): a purchase is a `success` payment until orders exist (F-501) | the only purchase built |
| `reserve_coupon` re-checks `not_started`, `period_limit_reached` and `first_purchase_only` under the coupon's row lock; first purchase also refuses a live hold of another first-purchase coupon on a different order | counts another buyer can move; cross-coupon it is best-effort |
| `redeem_gift_coupon` does not apply these limits; F-502-c refuses them on a `wallet_credit` coupon as `limits_not_for_gift_codes` | the gift box has no amount, gateway or purchase |

## A coupon in another currency than the order (built — F-116-h6)

`coupon-validation.ts` (`moneyIn`, the loader's rates); `reserve_coupon` in
`20260928003200_a_coupon_applies_only_in_its_own_currency`. Proved by
`coupon-currency.spec.ts`. ADR-0098 part 3; the rate is the user's call (2026-09-28).

| Rule | Why |
|---|---|
| A coupon's money — a fixed value, a percentage's cap, `minPurchaseAmount`, `maxPurchaseAmount` — is in its own `currencyCode`. The caller names the order's (`CouponRequest.currencyCode`: the operating currency on a top-up, the platform's on a billing top-up, the price's on an invoice) | a platform USD coupon on a reseller's IRR order took 2 rials off, not 2 dollars |
| When they differ, each is converted at the live rate, coupon -> order through the USD pivot (`FxRateReader.pair`, one read per coupon currency) before any gate or discount reads it; a percentage itself is a ratio and is not | the same number the deposit is priced with (F-116-e) |
| What a coupon gives (value, cap) and `maxPurchaseAmount` are rounded down to the cent, `minPurchaseAmount` up | a conversion never grants more than the coupon's own terms; a value under a cent is `nothing_to_discount` |
| A coupon that carries money and has no rate is `currency_unavailable` and takes nothing; a plain percentage with no bounds needs no rate | refused, never used as if in the order's currency |
| The redemption records `fxFromCode`, `fxRate` and each leg's snapshot (`fxSnapshotId` the order currency's, `fxFromSnapshotId` the coupon's, NULL for USD); all NULL when nothing was converted. `reserve_coupon` raises on a coupon carrying money in another currency with no rate | a receipt says what a dollar coupon was worth in rials that day |

## Management (built — F-502-c)

`billing-service/src/app/payment/coupon-admin/coupon-admin.service.ts`; audit
values in `20260914001300_coupon_admin_actions`. Proved by
`coupon-admin.service.spec.ts`. Refusals are `CouponAdminRefused.reason`.
**The pool follows the caller (ADR-0053, F-102-f-a):** the platform owner on the
cross-tenant pool; any other tenant in a `tenantTransaction` on the app pool, so
RLS stands behind every rule below. Batches and the usage report enter through
the same `within`. A tenant admin's one cross-tenant read is a lent gateway
config's owner (`gatewayConfigOwner`, read only).

| Rule | Why |
|---|---|
| The platform owner manages platform coupons and every tenant's; any other tenant its own. Out of reach or soft-deleted = `coupon_not_found`; a reseller's list filter by tenant is ignored | ADR-0048 decision 8, as gateways (D-31) |
| Create: `tenantId` absent = the caller's tenant, `null` = platform, another id = the platform owner only (`not_platform_owner`, `tenant_not_found`) | the body never widens the caller's reach |
| A code is stored trimmed and upper-cased, `[A-Z0-9][A-Z0-9_-]{2,39}` (`invalid_code`); a live duplicate in the same scope is `code_taken` — the partial index still decides a race | validation upper-cases what a user types |
| `tenantIds` (`coupon_tenant`) only on a platform coupon (`tenants_are_platform_coupons`) | ADR-0048 decision 2 |
| `targeted` needs at least one user (`targeted_needs_users`); every user lives in a tenant the coupon serves — its own, the named ones, or the platform owner's when none (`user_out_of_scope`) | a targeted coupon nobody can use is a mistake, not a setting |
| Gateways: a platform coupon names platform gateways only (`platform_coupon_needs_platform_gateway`); a tenant coupon its own `tenant` gateways or ones actively granted to it (`gateway_not_found`) | ADR-0048 decision 4, ADR-0041 |
| A service scope names one product or one variant, the platform's or the coupon's tenant's (`scope_not_found`) | the scope table's shape (F-026-a) |
| Values: a percentage in (0, 100], a cap on a percentage only, a positive value (`invalid_value`); the limit CHECKs answered first as `invalid_limit` | a reason, not a database error |
| A gift code (`wallet_credit`) takes no purchase, window, channel, gateway, scope or period limit (`limits_not_for_gift_codes`); expiry, per-user and total limits and targeting it keeps | `redeem_gift_coupon` reads only those |
| Those limits are read off the coupon **as it will be**, gateway and scope sets included (F-502-n): turning a discount coupon into a gift code is refused while either set stands, unless the same patch empties it | a patch carries only what the form changed, so the rows would survive the type change unseen |
| A used coupon (a counter above zero or any redemption row) keeps `discountType` and `discountValue` (`used_coupon_frozen`); `totalUsageLimit` never below `usedCount + reservedCount` (`capacity_below_used`) | a receipt already says what it took |
| The view says which one that is: `frozen` (`frozenBy`, the same rule), so a caller never re-derives it from the counters and offers an edit the service refuses (F-502-o). It is a counter, not a column — the audit snapshot drops it | a released redemption leaves no counter and still freezes |
| A child set given in a patch replaces the whole set; one not given is kept | one form, one answer |
| Delete: no redemption row in any status = hard delete with child rows; otherwise `isActive=false`, `deletedAt`, `deletedByAdminId` (`mode: soft_deleted`) | ADR-0048 decision 6 |
| Every write is one `admin_audit_log` row in the same transaction: `coupon_create` (full snapshot), `coupon_update` (only changed fields, old and new), `coupon_delete` (`mode`, `redemptions`); `tenantId` is the coupon's, or the caller's for a platform coupon | D-33 |
| A view's `status` is the first that holds: `deleted`, `inactive`, `expired`, `scheduled`, `exhausted`, `active` | what the list shows at a glance |

## Gift-code batches (built — F-502-d)

`coupon-admin/coupon-batch.service.ts`; audit values in
`20260914001400_coupon_batch_actions`. Proved by `coupon-batch.service.spec.ts`.

| Rule | Why |
|---|---|
| A batch is 1..5000 `wallet_credit` codes, each `totalUsageLimit=1`, `perUserUsageLimit=1`, public, one value (> 0, 2 places) and one expiry; ownership as a coupon's (`ownerOfNew`), `tenantIds` on a platform batch only | ADR-0048 decision 7 |
| A code is `[PREFIX-]` + 10 characters from `crypto.randomInt` over `ABCDEFGHJKMNPQRSTUVWXYZ23456789` (no 0/O/1/I/L) | a person types it off a card |
| A candidate live in the same scope or already drawn is drawn again, up to 8 rounds; the partial unique index decides a race and the whole batch rolls back | N asked is N made |
| No code is ever written to an audit row or a log; `coupon_batch_create` records count, value, prefix, expiry, tenants | a code is a bearer credit |
| CSV export (`code,value,expires_at,status,used`, CRLF) is audited as `coupon_batch_export` with the row count | whoever holds the file holds the credit |
| Deactivate switches every live code of the batch off and stamps `deactivatedAt` once; repeating it is harmless (`coupon_batch_deactivate`) | one act for a leaked batch |
| Another tenant's batch is `batch_not_found`; the list carries `codes`, `used`, `reserved` per batch, soft-deleted codes excluded | as a coupon's reach |

## Free service (built — F-502-l-a; redeeming it is F-502-l-b)

Migration `20260915000100_coupon_free_grant`; `coupon-admin.service.ts`,
`coupon-batch.service.ts`, `coupon-validation.ts`. Proved by
`coupon-admin.service.spec.ts`, `coupon-batch.service.spec.ts`,
`coupon-validation.spec.ts` and `coupon-scope.int.spec.ts`. D-35.

| Rule | Why |
|---|---|
| `free_grant` names one variant in `grantVariantId` and carries value 0; no other type names one (CHECKs `coupon_free_grant_names_variant`, `coupon_free_grant_has_no_value`; `invalid_value` first) | it gives a Grant of that variant, not money (catalog §4.7) |
| The variant is live (it, its product and its category on) and the platform's or the coupon owner's; a platform coupon names only a platform variant (`variant_not_found`). Any visibility, `admin_only` included | a coupon may assign what is not for sale (F-506) |
| It takes a gift code's limits and no purchase ones (`limits_not_for_gift_codes`) | it is redeemed in the gift box (D-35) |
| A used one keeps `grantVariantId` too (`used_coupon_frozen`) | a Grant was already issued from it |
| Validation and `reserve_coupon` refuse it at the top-up as `not_a_discount` | as a gift code |
| A batch naming `grantVariantId` makes free-service codes with value 0 (`invalid_value` otherwise) | D-35: created both ways |
| List kinds: `discount` = percentage, fixed and a free-service coupon made alone; `gift` = wallet credit and free-service codes made in a batch | the tab each is created in |

## Usage report (built — F-502-e)

`coupon-admin/coupon-usage.service.ts`. Proved by `coupon-usage.service.spec.ts`.

| Rule | Why |
|---|---|
| Per coupon or per batch: each redemption with code, user id, full name and username, payment id and status, discount (2 places) and its `currencyCode`, status, time; newest first, paginated (≤ 100), filtered by status and an inclusive `redeemedAt` range | D-33 |
| Totals over the date range, ignoring status filter and page: `redemptions`, `used` (confirmed), `reserved` (pending), `released` (expired + cancelled), and what confirmed ones gave | a hold gave nothing yet; a released one never will |
| What was given is summed **per currency** (`discountGivenByCurrency`, as written), then totalled in the owner tenant's currency now (`currencyCode`; the platform's for a platform coupon): a sum in an earlier one is converted through the tenant's `currency_change` rows (`convertedByChanges`), as settlement's owed is. No chain from a currency: `discountGiven: null`, never summed as written (F-116-h5) | a tenant that moved USD -> IRR reported 5.50 dollars and 1,500,000 rials as 1,500,005.50 |
| A redemption records `currencyCode`: the order's (invoice or top-up) for a held discount — `reserve_coupon` takes it from the caller, which priced the order — and the coupon's own for a gift code (F-116-h5) | the discount is part of the order's amount |
| A soft-deleted coupon still reports; another tenant's coupon or batch is `coupon_not_found` / `batch_not_found` | ADR-0048 decision 6; reach as F-502-c |

## HTTP surface (built — F-502-f)

`/api/billing/coupons` (`coupon-admin/coupon-admin.controller.ts`), behind
`coupon.manage` (`CouponPermissionGuard`, first door only) and per-user budgets
`COUPON_ADMIN_READ` / `COUPON_ADMIN_WRITE` (120 / 30 per 15 min). Proved by
`coupon-admin.controller.spec.ts` and `request/rate-limit-coverage.spec.ts`.

| Route | Body / query | Answer |
|---|---|---|
| `GET /coupons` | `tenantId` (uuid or `platform`, owner only), `status`, `kind` (`discount`/`gift`), `q`, `batchId`, `page`, `pageSize` | `{items: CouponView[], total, page, pageSize}` |
| `POST /coupons` | create body, `.strict()`; `tenantId` absent / `null` / uuid | 201 `CouponView` |
| `GET\|PATCH\|DELETE /coupons/:id` | patch `.strict()`, no `tenantId` | `CouponView`; delete `{id, mode}` |
| — | a `CouponView` carries `currencyCode`, the coupon's own: what a fixed `discountValue`, `maxDiscountCap` and the purchase bounds are in (F-116-h2) | — |
| `GET /coupons/:id/usage`, `GET /coupons/batches/:id/usage` | `status`, `from`, `to`, `page`, `pageSize` | `UsageReport` |
| `GET\|POST /coupons/batches` | list: `tenantId`, page; generate: `label`, `count` 1..5000, `value`, `prefix`, `expiresAt`, `note`, `tenantId`, `tenantIds` | page of `BatchView`; 201 `BatchView` |
| `GET /coupons/batches/:id` | — | `BatchView` |
| `GET /coupons/batches/:id/export` | — | `{filename, csv}` in the JSON envelope (the panel builds the file); spends the **write** budget |
| `POST /coupons/batches/:id/deactivate` | — | `{id, deactivated}` |

A refusal is `{reason, message}`: 403 `not_platform_owner`; 404 `*_not_found`;
409 `code_taken`, `used_coupon_frozen`, `capacity_below_used`; 400 the rest.
`batches/*` routes are declared before `:id`. No header or cookie name is new,
so `contracts/http/wire.json` is unchanged.
