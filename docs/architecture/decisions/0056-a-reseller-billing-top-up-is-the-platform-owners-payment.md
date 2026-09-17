---
id: adr-0056
status: accepted
updated: 2026-09-17
---

# ADR 0056 — A reseller's billing top-up is the platform owner's payment

- **Status:** accepted 2026-09-17 (row F-019-b)
- **Date:** 2026-09-17
- **Affects units:** billing, tenant

## Context

D-41: a reseller pre-pays the platform into `tenant_billing_wallet` and tops
it up online through the platform owner's gateways, on the existing deposit
path. That path is built for a tenant's user paying into their own tenant.
Every piece is keyed to the tenant in scope: the gateways offered (ADR-0006: a
`payment_gateway` only to the platform owner), the vault holding the merchant
id (D-25), the callback host (ADR-0020), the webhook scope (ADR-0051). A
reseller paying the platform fits none of them from its own scope.

## Decision

The user's call, 2026-09-17:

1. **The payment row lives in the platform owner's scope.** `tenantId` is the
   owner. A new nullable `payment_transaction.billingTenantId` names the
   reseller being credited. The gateway, the vault read, the callback host, the
   webhook scope, expiry and reconciliation all behave as for one of the owner's
   own users' top-ups. The platform is the merchant.
2. **Settlement has one branch.** With `billingTenantId` set,
   `creditVerified` credits `TenantBillingLedger` (`topup_payment`, reference
   the payment id) instead of a user wallet. It confirms no coupons, accrues no
   settlement and writes no `billing.payment.confirmed` event.
3. **That settlement runs on the cross-tenant pool.** Strict RLS hides a
   reseller's wallet from the owner-bound app pool, and the flip and the credit
   must commit together. ADR-0053 already serves the owner on that pool.
4. **A CHECK holds the shape:** a platform gateway, no grant, no discount.
5. **Who:** inside a reseller only — its owner, or a staff member holding
   `tenant_billing.topup`.

## Consequences

- Positive: nothing about gateways, vault, callback or webhook changed. A top-up
  settles on every path a user's does (callback, webhook, reconciliation,
  manual confirm).
- Negative / accepted cost: the bank returns the payer to the **platform's**
  panel host, not the reseller's. The result redirect is relative unless the
  owner vouches for the origin. A reseller's staff member does not see these
  payments on its own financial page (they are not in its scope). F-019-d reads
  the ledger instead.
- A second settlement pool, chosen per row. `grep -rn billingTenantId` is the
  audit.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| The row in the reseller's scope, on a platform gateway | breaks ADR-0006's offering rule and needs a second vault crossing beside a grant (`tenant/contract.vault.md` "The one crossing": by nothing else) |
| A separate payment table for tenant billing | duplicates the callback, webhook, verify and reconciliation machinery the row note asked to reuse |
