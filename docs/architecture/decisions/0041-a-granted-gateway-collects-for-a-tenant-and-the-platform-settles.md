---
id: adr-0041
status: accepted
updated: 2026-09-12
supersedes: adr-0006
---

# ADR 0041 — A granted gateway collects for a tenant, and the platform settles what it collected

- **Status:** accepted
- **Date:** 2026-09-12
- **Affects units:** billing, tenant, audit
- **Supersedes:** ADR-0006 (tenant end-user funds never transit the platform)

## Context

ADR-0006 said each tenant **must** connect its own gateway, so end-user money
never reached the platform: no aggregation, no settlement, no payout liability.
That holds for the default case and stays the default.

It forecloses two things the owner wants (decided 2026-09-12, D-27):

- attaching the **platform's own** gateway to a chosen tenant — for instance as
  part of a plan a reseller buys, so its users pay through the main site's
  gateway;
- lending **one tenant's** gateway to another tenant, and managing every such
  attachment centrally.

Either way the cash lands in the gateway owner's merchant account while the
paying user's wallet is credited inside the borrowing tenant. The platform then
owes that tenant, which is exactly the settlement obligation ADR-0006 avoided.

## Decision

1. **A tenant may use a gateway it does not own only through an explicit
   grant**, and a grant is created by the platform owner alone. No grant is
   implied by a plan, a tenant type or a provider; the default stays ADR-0006's:
   a tenant sees only the gateways it configured itself.
2. **A grant names one gateway and one borrowing tenant**, and the gateway may
   be a platform `payment_gateway` row or another tenant's
   `tenant_gateway_config` row. The owner of the row is unchanged by the grant.
3. **The merchant id stays the owner's** (D-26: one account per gateway row).
   A granted gateway is charged with the owner's credentials, so `billing` reads
   a credential of a tenant that is not the request's — the one place the
   boundary of ADR-0039 is crossed, and it is crossed only along a grant.
4. **What a granted gateway collects is a debt to the borrowing tenant**, in a
   settlement ledger of its own: every successful payment through a granted
   gateway accrues the credited amount (net of the gateway fee) as payable to
   that tenant.
5. **Settlement is a recorded manual payout**, for now: an operator transfers
   the money outside the system, then records the payout against the ledger with
   a proof attachment and their own identity. A payout is never automatic, and
   the ledger, not the operator's memory, says what is still owed.
6. **The owner may withdraw a grant, and a gateway that its owner deactivates or
   deletes stops working everywhere at once** — for its owner and for every
   tenant it was granted to. A grant never keeps a dead gateway alive.

## Consequences

- The platform becomes the collector of end-user money for any tenant holding a
  grant. That is a licensing and liability question for the business, not a
  technical one; ADR-0006's reasoning is still the reason the default is the
  other way.
- A payout that is never recorded is money the system believes it still owes, so
  the ledger needs an operator surface before the first grant is used in anger.
- Reading another tenant's credential along a grant means `billing` needs a path
  the RLS-bound vault connection does not give it today (ADR-0039). That path is
  the narrow, auditable exception, not a second pool for everything.
- `payment_transaction` must record which grant it was paid under, or the
  settlement ledger cannot be rebuilt from the payments.

## Alternatives rejected

| Option | Why rejected |
|---|---|
| Keep ADR-0006 unchanged | forecloses the plan the owner wants to sell, and the manual workarounds put the platform's merchant id into a reseller's vault with no record of the debt |
| Net the debt against the tenant's own platform invoice (F-019) | recommended and **not** chosen: the owner wants the obligation visible as a debt and paid out on its own schedule, not folded into subscription billing |
| Copy the owner's merchant id into the borrower's vault | two copies of one secret, and the borrower's admin surface would show a credential that is not theirs |

## Revisit trigger

A licence that makes aggregation routine, an automated payout rail, or the debt
growing past what a manual payout can keep up with.
