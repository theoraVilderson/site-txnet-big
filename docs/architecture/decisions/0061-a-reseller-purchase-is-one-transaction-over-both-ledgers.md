---
id: adr-0061
status: accepted
updated: 2026-09-18
---

# ADR 0061 — A reseller purchase is one transaction over both ledgers

- **Status:** accepted 2026-09-18 with F-019-h (user)
- **Date:** 2026-09-18
- **Affects units:** tenant, billing
- **Amends:** billing's "Wallet ledger" location (`billing/contract.md`)

## Context

F-019-h lets a platform user buy a reseller package from their own wallet
(user, 2026-09-18). That act touches two services' data. The buyer's `wallet`
belongs to `billing`, and `WalletLedgerService` in `billing-service` was its
only writer. The reseller's rows belong to `tenant`, and `tenant-service`
writes them on the cross-tenant pool, because RLS refuses another tenant's rows
on the app pool (ADR-0053).

A debit in `billing-service` followed by an HTTP call to `tenant-service` has a
window: the money is gone and the reseller does not exist. Closing that window
takes a purchase table, a compensating refund and a sweep. The same machinery
would be needed again for every later product sold across the two services.

## Decision

1. **`WalletLedgerService` lives in `shared-core`** (`lib/billing/wallet-ledger.ts`),
   as `TenantBillingLedger` already does for the same reason: it has writers in
   more than one service. `billing-service/src/app/wallet/wallet-ledger.service.ts`
   re-exports it, so no billing caller changed.
2. **A cross-tenant transaction names the wallet owner's tenant.** Such a
   transaction has no tenant extension, so `LedgerEntry.tenantId` stamps
   `wallet_transaction.tenantId`. Inside `tenantTransaction` it is left out,
   and the extension refuses a different one.
3. **The purchase is one transaction in `tenant-service`**: the reseller's rows,
   the buyer's debit (`reseller_purchase`), the first period credited to the
   reseller's billing wallet and charged from it, the subscription, and
   `active`. A short wallet throws inside the transaction, so nothing commits
   and nothing is refunded.

## Consequences

- Two services now write a user's wallet, through one class. The version
  guard, the amount checks and the `balanceAfter` chain are the same code for
  both.
- `billing` is no longer the only service that can move a user's money. A new
  writer is a review item. The protections are the ledger class and the
  database's CHECKs, not the service boundary.
- No purchase table, refund path or reconciliation sweep exists, and none is
  needed while a purchase stays inside one database.

## Alternatives rejected

- **Purchase in `billing-service` with a saga to `tenant-service`**: a crash
  between the two leaves a paid buyer with no reseller. Rejected by the user,
  2026-09-18.
