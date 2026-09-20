---
id: audit
layer: domain
status: active
version: 1
updated: 2026-09-13
---

# Contract — the settlement operator surface

The platform owner's back office over **granted gateways** (ADR-0041 §5/§6,
F-096-e): make a grant, withdraw one, see what is owed, and record the payout
that discharges it.

It is in this unit because every route here is an **audited admin action** —
that is the whole of what makes it different from the rest of `billing`, whose
routes are a signed-in user acting on their own wallet. The ledger it operates
on is `billing`'s (`payment_gateway_grant`, `gateway_settlement_entry`,
`gateway_settlement_payout`, F-096-a), and the rules for what those rows *mean*
are `domains/billing/contract.deposit.md` "The debt it leaves".

**The code lives in `billing-service`**, not beside the other operator routes in
`auth-service`. The tables, the money arithmetic and `isPlatformOwner` are all
there, and moving the routes would put the ledger's arithmetic outside the unit
whose contract states it. The cost is the one exception below.

## Routes

`/api/billing/settlement/*`. Every one of them requires **both** doors in
"Who may reach it".

| Operation | Input | Output | Errors |
|---|---|---|---|
| list grants | `?tenantId` (optional) | up to 200 grants, newest first, live and withdrawn | — |
| create a grant | borrowing `tenantId` + **exactly one** of `gatewayId` / `tenantGatewayConfigId`, `note?` | the grant | `gateway_not_found`, `tenant_not_found`, `gateway_not_grantable`, `grant_to_owner`, `already_granted` |
| withdraw a grant | grant id | the grant, inactive, with `withdrawnAt` | `grant_not_found`, `already_withdrawn` |
| what is owed | — | per tenant: `accrued`, `paidOut`, `outstanding` — decimal **strings** (C-02), most owed first | — |
| record a payout | `tenantId`, `amount`, `method?`, `reference?`, `proofAttachmentKey?`, `notes?` | the payout | `amount_not_positive`, `exceeds_outstanding` |

A refusal names its `reason` in the body. That is deliberate and does **not**
generalise: this is an operator surface, where naming the rule that refused is
the point; on a user-facing route it would be more than the caller is owed.

`tenantId` travels in the **body** on every write, which is the opposite of
every other billing route. It is the *subject* — who is borrowing, who is being
paid — not the caller, whose own tenant still comes only from the gate.

## Who may reach it

Two doors, and the second is the real one.

1. `SettlementPermissionGuard` requires `settlement.manage` in the gate's
   `X-User-Permissions`. This narrows the surface to a deliberate role and
   produces the 403 that says so.
2. `SettlementService.assertOperator` requires the caller's tenant to **be**
   `TenantType.platform_owner`, read on the application pool inside the caller's
   own scope. Every operation opens with it.

The first is not a boundary: a reseller administers its own roles, so a tenant
admin can hold `settlement.manage` without the platform owner ever agreeing.
The second is what keeps this surface the platform owner's.

## Why it reads on the cross-tenant pool, and the limit that leaves

All three settlement tables carry `tenantId` = the **borrowing** tenant and are
isolated on it. That is right for the borrower — a reseller sees the grants made
to it and the debt owed to it, and nothing else — and it is the wrong key for
this surface, whose job is to look *across* tenants. The platform owner bound to
its own `app.tenant_id` sees none of the rows it is responsible for. So these
routes use `CrossTenantPrismaService` (the `txnet_cross_tenant_user` login role,
`USING (true)`; a policy, never `BYPASSRLS`).

**Stated limit, not a workaround.** There is no database-level backstop on the
write. RLS on these tables keys on the borrower, so it cannot express "only the
platform owner may INSERT", and a `WITH CHECK (current_user = …)` policy would
only restate the pool this service already chose. A bug in `assertOperator` is
therefore a real hole. It is one function, called from one place per operation,
and `settlement.service.spec.ts` asserts it over **every** public method from a
list — so a method added later is covered without anyone remembering to. Closing
it properly wants a platform-owner marker the database can see; that is a
decision of its own and has not been taken.

## The rules the routes carry

- **A gateway is never granted to the tenant that owns it.** Not harmless:
  `deposit-pricing.ts` lists a tenant's own gateways and its granted ones as two
  groups, so it would appear twice on the top-up screen — and a payment through
  it would accrue a settlement debt from a tenant to itself, money the platform
  never held.
- **An in-chat gateway is never granted** (D-32, F-104-p): `telegram_stars`
  and `bale` answer `gateway_not_grantable` (409), platform or reseller-owned.
  Their money lands in the owning tenant's own bot, which the borrower's user
  never talks to. Every other provider stays grantable; `GRANTABLE` in
  `settlement.service.ts` is exhaustive over `PaymentProviderName`, so a new
  provider does not compile until it is decided. A grant made before this row
  is not withdrawn by it.
- **One live grant per (tenant, gateway).** Nothing downstream picks between
  two, so withdrawing one would leave the gateway working with no visible reason
  why. A withdrawn grant is no obstacle to a new one.
- **A withdrawal is refused, not idempotent**, when the grant is already
  withdrawn. A second one is a double-click or a stale screen, and a second
  audit row naming a second admin would misdescribe who stopped it. The
  `updateMany` filter carries `isActive: true` for the same reason, so a lost
  race writes no audit row.
- **A payout never exceeds what is outstanding.** The money has already left a
  bank account by the time anyone reaches the route, so the recording cannot
  undo a mistake — but a payout of 1,000 where 100 was owed is a typo far more
  often than a transfer, and ADR-0041 §5 makes the ledger the authority on what
  is still owed. An operator who really did over-pay has a true thing to record
  and no way to record it here; that wants an ADR, not a silently negative
  balance.
- **Two payouts recorded at once cannot together exceed it either** (F-096-g).
  What is owed is summed, not stored, so there is no row to lock: a balance read
  before the transaction is a number another payout can move before the insert
  lands, and a double submit would write both. `recordPayout` takes
  `pg_advisory_xact_lock` on the tenant being paid as the first statement of its
  transaction and sums the ledgers after it, so the second caller waits, re-reads
  and is refused by the rule above. Nothing else locks on that tenant, and the
  lock ends with the transaction.
- **What is owed is summed from the two ledgers on every call**, never cached on
  the tenant. A running balance is a second source of truth for money, and the
  first time it disagreed with the rows there would be no way to say which was
  right.

## The proof attachment (F-033)

`proofAttachmentKey` is a string the operator **types**, stored verbatim.
Nothing resolves it, serves it or checks that it names anything: the object
store is D-8's port and arrives with F-033. The upload then writes this same
column and no schema changes. Until then a payout's proof is a reference an
operator filed elsewhere, which is weaker than ADR-0041 §5 asks for and is the
reason that row names F-033.

## The exception this surface opens

`billing-service` writes `audit.admin_audit_log` directly — the one generated
Prisma client covers every schema, so this works, and it makes
`prisma.service.ts`'s "only ever queries the `billing` models" no longer
literally true. It is amended there with a pointer here rather than quietly
broken. `auth-service` remains the only other writer.

Three `AdminAction` values and two `AuditTargetType` values were added for it
(`20260912000300_settlement_admin_actions`) rather than reusing
`tenant_settlement_approve`: a trail that cannot tell a grant from its
withdrawal does not answer the question it exists for.
