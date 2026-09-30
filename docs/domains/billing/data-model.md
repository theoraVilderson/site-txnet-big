---
id: billing
layer: domain
updated: 2026-09-29
---

# Data model — billing

Source of truth: `txnet-backend/prisma/domains/billing.prisma` (Postgres schema
`billing`).

## Tables owned
| Table | Purpose | Tenant-scoped? | Retention |
|---|---|---|---|
| wallet | user balance cache + optimistic version; `heldAmount` = its open holds' sum, `CHECK (cachedBalance - heldAmount >= 0)` (F-118-a); `heldPushedAt` = when a hold last announced itself (F-118-o) | via owner user | permanent |
| wallet_hold | money locked for one `ownerRef` (a Grant, a per-use token): `amount` held now, `captured` so far, `status` `open`/`closed` (closed = `amount` 0 + `closedAt`, CHECK), `currencyCode` = its wallet's while open; one open per `(walletId, ownerRef)` (partial unique index); a deferred trigger ties it to `wallet.heldAmount` — [contract.holds.md](contract.holds.md) | via its wallet | permanent |
| usage_authorization | a per-use door's token (F-118-h, [contract.usage-rating.md](contract.usage-rating.md)): `(grantId, meterKey)` -> `grant_meter`, `(grantId, meterKey, idempotencyKey)` unique, `quantity` > 0, `status` `open \| committed \| cancelled \| expired` (`settledAt` iff not open; `committedQuantity` iff committed, `0..quantity` — CHECKs), what it bought — `boughtUnits`, `heldAmount`, `wholesaleUnits` — and `expiresAt`; never deleted | `tenantId` (its meter's, `same_tenant()`), strict RLS | permanent |
| usage_event | one reported use of a Grant's meter (F-118-f): `(grantId, meterKey)` -> `grant_meter`, `quantity` > 0, `occurredAt`, `(source, idempotencyKey)` unique = the dedup; append-only; advances `grant_meter.consumed` | `tenantId` (its meter's), strict RLS | permanent |
| wallet_transaction | append-only money ledger (`balanceAfter` per row) | denormalized `tenantId` | permanent |
| spending_cap | the owner's cap on one Grant's usage (F-118-i): `label`, `amount` > 0 in the wallet's `currencyCode`, `period` `none`/`monthly` from `startsAt`, `spent` this period since `periodStartsAt`; one per Grant; replaces `sub_account` (dropped) — [contract.spending-cap.md](contract.spending-cap.md) | `tenantId` (its Grant's, `same_tenant()`), strict RLS | with its Grant |
| wallet_transfer_request | OTP-confirmed user->user transfer state machine | — | permanent (audit) |
| coupon + coupon_service_scope + coupon_allowed_user + coupon_redemption + coupon_batch + coupon_gateway | coupon engine (reserve/confirm), management | `coupon.tenantId` nullable (null = platform coupon, serving the platform owner's users only — ADR-0099); soft delete; `coupon_redemption.currencyCode` = what its discount is in (F-116-h5); `fxFromCode`/`fxRate`/`fxSnapshotId`/`fxFromSnapshotId` = the rate a coupon in another currency was converted at, else NULL (F-116-h6) | permanent |
| payment_gateway | platform-brand gateway config (card/rial/crypto); `taxRatePercent` null = the tenant's `deposit_setting` default (ADR-0076) | platform-owner only | permanent |
| payment_transaction | payment intent + status + confirmation source; `billingTenantId` set = a reseller's billing top-up in the platform owner's scope (ADR-0056); `payerChatPlatform` + `payerChatId` (both or neither, CHECK) = an in-chat payment's payer, the only sender its relayed events are admitted from (F-104-ab) ; a row with no `returnOrigin`, an `expiresAt` already past and a **transfer's** reference as its code is a follow-on — money that arrived for an invoice already settled, written as a payment of its own (F-104-s, ADR-0068) | denormalized `tenantId` | permanent |
| payment_reconciliation_log | inquiry-API cross-check results | via payment | permanent |
| crypto_payment_detail | asset/network/address/confs/rate snapshot | via payment | permanent |
| affiliate_referral + affiliate_commission | affiliate payout ledger | — | permanent |
| payment_gateway_grant | who may use whose gateway (ADR-0041). Withdrawn, never deleted | `tenantId` = the **borrowing** tenant | permanent |
| gateway_settlement_entry | what a granted gateway collected, one row per payment, append-only — the debt | `tenantId` = the tenant owed | permanent |
| gateway_settlement_payout | a recorded manual transfer with its proof and its operator — the repayment | `tenantId` = the tenant paid | permanent |
| invoice | one purchase of one catalog variant, server-priced (`priceId` = the price row used), `total = amount - discount` (CHECK); what an automatic rule took is `ruleDiscount` (inside `discount`, CHECK) and `discountRuleId` names it (F-114-h); its coupon holds are `coupon_redemption` rows with its id as `orderReferenceId` (F-111-a) | `tenantId`, strict RLS | permanent |
| discount_rule | a discount with no code (F-114-h, ADR-0087): `kind` (`percentage` / `fixed_amount`) + `value`, covering everything, a `productId` or a `categoryId` (never both, CHECK), for everyone, its named users (`forNamedUsers`) or one user group's user members (`groupId`, F-114-j; never both, CHECK), from `startsAt` to `endsAt` (null = open); switched off, never deleted once invoiced | `tenantId`, strict RLS | until switched off |
| discount_rule_user | a user a `forNamedUsers` rule serves; `(ruleId, userId)` key | `tenantId`, strict RLS | with its rule (cascade) |
| grant_bulk_outcome | one Grant's outcome of one bulk admin request (F-311-u1): key `(tenantId, requestId, grantId)`, the body's `fingerprint`, the outcome JSON as answered — a repeat answers it and acts on nothing again. No FK: a `grant_not_found` outcome may name no Grant | `tenantId`, strict RLS | 30 days: with its job (F-311-u3), or by `createdAt` when it has none |
| grant_bulk_job | a bulk act by filter run by the worker (F-311-u2): `(tenantId, requestId)` unique, `fingerprint`, the actor (`actorUserId`, `actorIp`, `byPlatform` — admitted as platform staff, F-118-ac), `action`, `command` (input + reason), `filter`, `status` `running`/`done`/`cancelled`, `total` and the `ok`/`refused`/`failed` counts, `finishedAt`, `purgedAt` (F-311-u3). [contract.reseller-grants-bulk.md](contract.reseller-grants-bulk.md) "By a filter" | `tenantId`, strict RLS | permanent — its counts outlive its items |
| grant_bulk_job_item | one Grant of a bulk job, frozen at the confirm (F-311-u2): key `(jobId, grantId)`, `tenantId`, `attempts`, `doneAt` (null = pending), `ok`, `failed` (after 3 attempts); its outcome is `grant_bulk_outcome`'s row under the job's `requestId`. Partial indexes on pending and on done | `tenantId`, strict RLS | 30 days after its job ended (F-311-u3) |
| currency_change | one change of a tenant's operating currency (F-116-f): `fromCode`/`toCode` (differ, CHECK), `rate` `DECIMAL(30,18)` > 0, the legs' `fromSnapshotId`/`toSnapshotId` (FK `currency_exchange_rate`, RESTRICT), `changedByUserId`, `summary` (counts converted). The ledgers read it to convert a late credit | written on the cross-tenant pool only; the app pool reads its own tenant's and the platform's | permanent (evidence) |

## Currency (F-116-b, ADR-0098 parts 2–3)

`wallet`, `wallet_transaction`, `invoice`, `payment_transaction`, `coupon`,
`discount_rule`, `deposit_setting`, `gateway_settlement_entry`,
`gateway_settlement_payout`, `payment_gateway` and `tenant.tenant_gateway_config`
each carry `currencyCode` (`^[A-Z]{3}$` CHECK, NOT NULL, **no default**): what that
row's amounts are in. Backfilled `USD` by `20260928002500_every_money_row_records_its_currency`.
A new row takes the owner tenant's `operatingCurrencyCode` at the moment it is
written (`operatingCurrencyOf`); a platform gateway, a platform coupon and a billing
top-up take the platform's (`platformCurrencyOf`). A payment's follow-on, its
settlement entry and its wallet credit take the payment's; a wallet takes its first
credit's. Never re-derived from the tenant afterwards: its currency may change
(F-116-f). A `wallet_transaction` in another currency than its wallet's is refused
by the trigger `wallet_transaction_in_wallet_currency`.
A payment's `exchangeRateSnapshot` is `currencyCode` -> the charge currency
(`DECIMAL(30,18)`, F-116-e) through the USD pivot; `exchangeRateSnapshotId` is the
charge currency's leg and `exchangeRateFromSnapshotId` the payment currency's, each
NULL when that side is USD (`20260928002700_a_payment_records_both_legs_of_its_rate`).
A gateway's `staticRate`, `fixedAmountModifier`, `minRate`, `maxRate` (`payment_gateway`
and `tenant.tenant_gateway_config`) are `DECIMAL(30,18)` too: a currency change divides
them (`20260928003000_a_gateway_rate_keeps_an_inverse_pair`); `roundingStep` stays `(18,8)`.
A credit converted through a `currency_change` (F-116-f) carries what it was before:
`wallet_transaction.sourceAmount` + `sourceCurrencyCode`, both or neither, the code
never the row's own (CHECKs in `20260928002900_a_currency_change_converts_live_money`,
which also added `currencyCode` to the four tenant <-> platform tables — tenant's
data-model). `currency_change` is the `WalletReasonType` of a change's closing and
opening rows (`20260928002800`, alone because a new enum value is unusable in the
transaction that adds it).

## Relationships crossing unit boundaries
| This table | -> | Other unit's table | Why it is allowed |
|---|---|---|---|
| wallet.ownerUserId | -> | identity.user.id | one wallet per user |
| spending_cap.grantId | -> | entitlement.grant.id | a cap bounds one Grant; `Cascade` |
| coupon_service_scope.productId / variantId (exactly one) | -> | catalog.product / product_variant | coupon targeting (F-026-a) |
| coupon.grantVariantId | -> | catalog.product_variant | what a `free_grant` coupon gives (D-35); `Restrict`, a variant is never deleted |
| affiliate_commission.payoutWalletTransactionId | -> | billing.wallet_transaction | payout is itself a ledger entry |
| payment_gateway_grant.tenantGatewayConfigId | -> | tenant.tenant_gateway_config | a grant may lend one reseller's gateway to another (ADR-0041 §2); the owner is unchanged by it |
| invoice.variantId / priceId | -> | catalog.product_variant / price | what was invoiced and at which price; `Restrict`, so an invoiced variant is archived, never deleted (F-026-h) |
| discount_rule.productId / categoryId | -> | catalog.product / product_category | what a rule covers; `Cascade` — a rule on a deleted product or category covers nothing |
| discount_rule.(groupId, tenantId) | -> | governance.user_group.(id, tenantId) | whom a rule serves (F-114-j); the pair keeps it the rule's tenant's group; `Restrict`. Pricing reads the buyer's `user_group_member` rows, read-only, in the buyer's tenant |

## Access rules

Planned: no unit outside billing writes these tables; balances/history are read
via a billing service API only.

## Migration notes

`traffic`/high-volume tables live in `network`, not here. Partial unique index
for active coupons and RLS are "section 99" manual SQL — not applied.

**The three settlement tables carry constraints Prisma cannot express**
(`20260912000200_gateway_grant_and_settlement`, F-096-a), and each is a way the
platform could otherwise come to owe the wrong tenant the wrong money:

- a grant names **exactly one** gateway — a CHECK, like `payment_transaction`'s;
- **one live grant per (tenant, gateway)** — two *partial* unique indexes,
  `WHERE "isActive"`, so granting, withdrawing and granting again is ordinary
  while two live rows disagreeing is impossible;
- a withdrawal is **complete** — inactive rows carry when and by whom, live rows
  carry neither;
- **one accrual per payment** — a unique key, because the transaction that
  writes it is reached by a retried callback *and* a reconciliation sweep;
- amounts: an accrual is `>= 0` (a fee can eat a whole payment), a payout `> 0`.

All three are RLS shape A (strict) on the borrowing tenant. **Reading is
isolated; writing is not restricted to the platform owner** — the admin surface
has no tenant of its own yet, the same gap `admin_audit_log` has. Proof:
`payment/gateway-grant-schema.int.spec.ts`.

**Tax on a top-up is two-level** (`20260924001300_tax_on_top_up_returns`,
F-104-ae, ADR-0076): `taxRatePercent` on `payment_gateway` and
`tenant.tenant_gateway_config` (null = inherit) over the tenant's default on
`deposit_setting` (null = no tax), each `DECIMAL(9,4)` with a 0..100 CHECK.
`payment_transaction` keeps `taxApplied` and the rate it was charged at; a
CHECK makes "no rate" imply `taxApplied = 0`, which is also how every payment
recorded before the migration reads. Additive only — nothing was backfilled.
Proof: `shared-core/src/lib/prisma/billing-top-up-tax.spec.ts`.

There is deliberately **no outstanding-balance column**: what is owed is the
accruals minus the payouts, because ADR-0041 §5 says the ledger and not a
remembered total is what says so.
