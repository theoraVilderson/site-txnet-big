---
id: tenant
layer: domain
status: active
version: 11
updated: 2026-09-17
---

# Contract — tenant / the billing wallet

A topic file of `contract.md` (§10). A reseller's **prepaid** balance with the
platform (D-41, D-01) — what the platform charges a reseller from, never what a
reseller's users pay into (that is `billing`'s `wallet`; ADR-0006 keeps the two
apart). Built by F-019-a; top-up (F-019-b), subscription (F-019-c) and the
panel page (F-019-d) build on it.

## The ledger — `TenantBillingLedger` (shared-core)

`credit(tx, entry)` / `debit(tx, entry)` in
`shared-core/src/lib/tenant/billing/tenant-billing-ledger.ts`. The only writer
of `tenant_billing_wallet.cachedBalance` (invariant 3). The same shape as
`billing`'s `WalletLedgerService` (`billing/contract.md` "Wallet ledger").

| Rule | Why |
|---|---|
| Takes the caller's `tx` and opens none | the caller's own row — a payment's status, an audit row — commits with the movement |
| `entry.tenantId` is required; the tables are not in `TENANT_SCOPED_MODELS` | the writer may be the platform owner acting on another tenant (below); strict RLS on `tenant_billing_wallet` stands behind it on the app pool |
| `amount` is base currency (C-02), `> 0`, at most 2 decimal places; anything else is `TenantBillingInvalidAmount`, never rounded | invariant 14; the column would round the amount but not `balanceAfter` |
| A `referenceId` already used with the same `reasonType` is `TenantBillingDuplicateEntry`, checked before any write; a race past the check meets the unique index and gets the same error | invariant 15: a payment, a renewal or an admin request moves the balance once |
| A debit below zero, or from a tenant with no wallet, is `TenantBillingInsufficientBalance` | prepaid only (D-01); a missing wallet is a zero balance |
| `cachedBalance` is written with `where { id, version }` **before** the row is appended; `count = 0` is `TenantBillingVersionConflict` — thrown, not retried | a loser appends nothing; only restarting the caller's transaction reads the row fresh |
| A first credit opens the wallet (`createMany … skipDuplicates`) | two first credits meet at the version guard |
| Returns the appended `tenant_billing_transaction`, whose `balanceAfter` is the new balance | — |
| **Every credit writes a `tenant.billing.credited` outbox row** (`{tenantId, transactionId, balanceAfter}`) in the caller's `tx` | an unpaid renewal is charged as soon as money lands, whichever writer credited it (F-019-c) |

`reasonType` in use: `admin_manual_adjust` (F-019-a), `topup_payment` (F-019-b),
`subscription_charge` (F-019-c). `metered_usage_charge` and
`sms_usage_charge` stay in the enum unused (D-41: no metering).

## Manual adjustment — the HTTP surface

`POST /api/billing/tenant-wallets/:tenantId/adjustments`, served by
`billing-service` (`app/tenant-billing/`) beside the other money surfaces.

| | |
|---|---|
| Body | `{direction: credit\|debit, amount: "250.50", requestId: uuid, note?: string ≤500}`, `.strict()` |
| Door | permission `tenant_billing.adjust` — granted to `Admin` (and SuperAdmin's `*`); then the service's owner check, which is the boundary |
| Who | **the platform owner only.** A reseller never adjusts its own balance |
| Pool | ADR-0053: the caller is read on the app pool; a non-owner is refused before `CrossTenantPrismaService` is touched, the owner writes on it |
| Idempotency | `requestId` is the entry's `referenceId`; the same request again is `409 duplicate_request` |
| Audit | one `admin_audit_log` row, `tenant_billing_adjust` / `tenant_billing_wallet`, in the same transaction; `note` lives only there |
| Rate limit | `TENANT_BILLING_ADMIN_WRITE`, 30 per 15 min per user |
| `201` | `{transactionId, tenantId, direction, amount, balanceAfter, createdAt}` — decimals as strings |

| `reason` | status |
|---|---|
| `not_platform_owner` | 403 |
| `tenant_not_found` | 404 |
| `not_a_reseller` — the target is the platform owner | 400 |
| `invalid_amount` | 400 |
| `insufficient_balance` | 409 |
| `duplicate_request` | 409 |
| `wallet_changed` — a concurrent movement won; send again with a new `requestId` | 409 |

## What the database holds for every writer

Migration `20260917000900_tenant_billing_wallet`: `cachedBalance >= 0`,
`balanceAfter >= 0`, `amount > 0` (CHECKs), and a partial unique index on
`(reasonType, referenceId)` where the reference is set.

## Top-up — the reseller pays the platform (F-019-b, ADR-0056)

`TenantTopupController` + `TenantTopupService` in `app/tenant-billing/`, over
billing's deposit start and settlement (`billing/contract.deposit.md`).

| Route | Body | Answers `data` |
|---|---|---|
| `GET /api/billing/tenant-wallet/topup/gateways` | — | the deposit list's shape, the platform owner's `platform` gateways only |
| `POST /api/billing/tenant-wallet/topup` | `{gatewayId, amount}`, `.strict()`, the deposit start's rules | the deposit start's answer: `{paymentId, redirectUrl, amount, fee, payable, credited, …}` |

| Rule | Why |
|---|---|
| Inside a **reseller** only; its `ownerUserId`, or a staff member holding `tenant_billing.topup` (granted to `Admin`). Else **403** `not_a_reseller` / `not_permitted`, before any gateway is read | the platform owner has no billing wallet; the permission header is the caller's own tenant's roles |
| The payment is started in the **platform owner's** scope: `source: platform`, no coupon, no test mode, and `billingTenantId` = the reseller | the platform is the merchant: its gateway, vault, callback host and webhook scope, unchanged |
| A billing top-up that would be free, in chat, granted or on a tenant gateway is **404** `gatewayNotFound` | the row's CHECK: platform gateway, no grant, no discount |
| Settling credits **this** wallet, `topup_payment`, `referenceId` = the payment id, and no user wallet; on every settling path (callback, webhook, reconciliation, manual confirm); flip and credit in one transaction on the cross-tenant pool | invariant 15 makes a second credit impossible; strict RLS hides the wallet from the owner-bound app pool |
| No `billing.payment.confirmed` event, no coupon use, no settlement accrual | that event means "a user's wallet grew" |
| Rate limits: the deposit buckets, per user (`DEPOSIT_GATEWAYS`, `DEPOSIT_START`) | the same act at the same bank |
| The bank returns to the **platform's** panel host; the result redirect is relative unless the owner vouches for the origin | ADR-0056's accepted cost |

**Proof:** `tenant-billing/tenant-topup.spec.ts`.

## The reseller's read (F-019-d)

`GET /api/billing/tenant-wallet?page&pageSize` — `TenantWalletController` +
`TenantWalletService` in `app/tenant-billing/`; the panel page is
`panel-web/contract.financial.md`.

| Rule | Why |
|---|---|
| The top-up's door (`admitResellerBilling`): inside a reseller, its owner or `tenant_billing.topup`; else **403** `not_a_reseller` / `not_permitted`, before the wallet is read | the same people who pay are the ones who see what they paid |
| Read in the caller's own scope on the **app pool**: the wallet by `tenantId` under strict RLS, the rows by that wallet's id | the cross-tenant pool would answer any reseller's wallet for a wrong id |
| `balance` is `cachedBalance`; rows newest first, `id` breaks a tie; no wallet is `balance: "0.00"` and no rows | invariant 3 — never a sum; a wallet opens on the first credit |
| `page` / `pageSize` optional (1 / 20), `pageSize ≤ 100`, `.strict()`; a bad one is 400 `billing.pageInvalid` | the wallet history's paging |
| Rate limit: `WALLET_HISTORY`, per user | the same act: reading a money list |

`200`: `{balance, total, page, pageSize, rows: [{id, direction, reasonType,
amount, balanceAfter, createdAt}]}` — decimals as strings. No `referenceId`:
an adjustment's is the platform owner's request id.

**Proof:** `tenant-billing/tenant-wallet.spec.ts`.

## Subscription renewal — the platform charges (F-019-c)

`TenantRenewalService` in `auth-service/src/app/tenant/renewal/`. What the
renewal does to a reseller's status is [rules.md](rules.md) #10-#13; the
invariant is 19.

| Trigger | Route (`ServiceOnlyGuard`, `system`, no tenant) |
|---|---|
| `tenant_subscription_renewal` job, seeded every 5 min | `POST /api/internal/tenant-subscriptions/renew-due` -> `{due, renewed, warned, suspended, waiting, not_due, skipped, failed}` |
| `tenant.billing.credited` (worker `TenantBillingCreditedConsumer`) | `POST /api/internal/tenant-subscriptions/:tenantId/renew` -> `{outcome}` |

| Rule | Why |
|---|---|
| Due = `currentPeriodEnd <= now`, reseller, not deleted, not `terminated`; the sweep takes 500 oldest first, one transaction each, and one failing tenant is `failed` without stopping the rest | a broken row never blocks every other reseller's renewal |
| **One transaction on the cross-tenant pool: the package `FOR SHARE`, then the tenant `FOR UPDATE`**, the subscription re-read under both | the lock order of every subscription write (`package-entitlements.ts`); two renewals of one tenant serialise |
| The price is the package's **current** price for `tenant.billingModel`; a package is renewed on even when inactive | deactivating stops new sales, not renewals (user, 2026-09-17) |
| **Paid** (`cachedBalance >= price`): one `subscription_charge` debit, `referenceId` = a name-based UUID of (tenant, the `currentPeriodEnd` it pays for) | a period is charged once; invariant 15 stands behind the lock |
| The new `currentPeriodEnd` = one calendar month / year (UTC, clamped to the month end) from the old end — or **from now** after a `non_payment` suspension; if that is still not in the future, from now | paid in grace, the grace days were used; paid after suspension, those days were not served (user, 2026-09-17); a stopped sweep never charges missed periods back to back |
| The same transaction clears `renewalWarnedAt` and `graceUntil` and replaces the tenant's `package_included` entitlements with the package's keys | F-018-o: a key removed from the package goes at renewal |
| **Short:** nothing is debited — prepaid only (invariant 14) | D-01 |
| Short before the deadline — `currentPeriodEnd` + `renewalGraceDays`, or the platform owner's later `graceUntil` (F-019-g, `contract.admin.md`) — warns; at or after it, suspends | more time is given by moving the deadline, not by crediting money that never arrived |
| Every notice is an outbox row in the renewal's transaction: `tenant.subscription.payment_due` `{tenantId, ownerUserId, amount, balance, suspendsAt}`, `tenant.subscription.suspended` `{tenantId, ownerUserId, amount, balance}` | a warning is owed exactly when the state that caused it committed (ADR-0021) |
| The worker's `TenantSubscriptionNoticeConsumer` sends them to the owner through `POST /api/internal/notify/user` (`subscriptionPaymentDue` / `subscriptionSuspended`): the panel inbox always, the owner's linked bots best effort, in the owner's language | an owner may have no linked bot; the inbox copy is the one that must land |

**Proof:** `tenant/renewal/tenant-renewal.spec.ts`.

## Not built

No quote route for a top-up (start answers the breakdown); the panel page
(F-019-e) sends the start and follows the bank. A reseller does not yet see
its next renewal date or price in the panel.
