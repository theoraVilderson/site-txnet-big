---
id: tenant
layer: domain
status: active
version: 9
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

`reasonType` in use: `admin_manual_adjust` (F-019-a). `topup_payment` and
`subscription_charge` are F-019-b / F-019-c. `metered_usage_charge` and
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

## Not built

No read route: the reseller's balance and history are F-019-d. No top-up
(F-019-b), no charge (F-019-c).
