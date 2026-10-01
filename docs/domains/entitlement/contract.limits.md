---
id: entitlement
layer: domain
status: draft
version: 30
updated: 2026-09-30
---

# Contract — entitlement: how many a user may hold (F-118-ao)

A §10 split of [contract.md](contract.md), which is at its ceiling. A metered
Grant costs nothing at the sale and holds a panel seat from it, used or not, so
a user could buy a hundred and fill the panels (user, 2026-09-30).

## The metered cap

A user holds at most **N open metered Grants**: open = `pending`, `active` or
`suspended` (`OPEN_GRANT_STATUSES`); `expired`, `exhausted` and `cancelled`
count for nothing. A package plan (prepaid) was paid for in full and never counts.

N, first found wins (`meteredCapOf`, `entitlement/metered-cap.ts`):

1. the user's own number, `user_grant_limit` — set by staff, the answer to a
   ticket; it replaces the default, higher **or lower**;
2. the tenant's default, `grant_limit_setting` — each tenant sets its own;
3. the platform's, `PLATFORM_METERED_CAP` = **5** (in code, not a row).

`0` at either level sells that user, or every user of the tenant, none.

**Never above the reseller's ceiling** (F-019-n, ADR-0106 key
`user_metered_cap_max`, default 20): N in effect is `min(N, ceiling)`
(`meteredCeilingOf`, `underCeiling`), so a number set before the ceiling was
lowered counts as the ceiling. The platform's own tenant has none.

A cap, not an entry fee: a fee bounds nothing a paying user does, and the
problem is seats, not money (user, 2026-09-30).

## Where it is held

- **`InvoiceService.create`**: a metered variant past the cap gets no invoice,
  so the user is told before paying.
- **`GrantService.issue`**, `source = purchase` only: the count again, in the
  payment's transaction — a debit and a refusal roll back together.

Both count under `pg_advisory_xact_lock(hashtext('metered_cap:<userId>'))`,
held to the end of the caller's transaction, so two sales at once cannot both
see room for one (`assertMeteredRoom`).

**Staff's own issue is never refused** (`admin_grant`, coupon, migration,
trial…): it counts toward the cap, so a user given one by staff has one fewer
to buy.

## Refusal

`MeteredCapReached` (an `EntitlementRefused`, reason `metered_cap_reached`)
carries `cap` and `open`. Over HTTP (`invoice.controller.ts`, create and pay):
**409**, `i18nKey` `errors.billing.invoice.meteredCapReached` ("open a support
ticket"), `error.facts = { cap, open }`.

## Staff routes (F-118-ap)

`GrantLimitsController` / `GrantLimitsService` (`billing-service/.../payment/gift/`),
on the users-admin door, `ResellerAccess.runIncludingPlatform`: the
platform's staff (`tenant.manage`) on any tenant and on the platform's own; a
reseller's owner and its staff on theirs. The tenant is the path's, never the
caller's session.

| Route | Body | Answers |
|---|---|---|
| `GET /api/billing/tenants/:tenantId/grant-limits` | — | `{platformDefault, tenantDefault \| null, effective}` |
| `PUT` the same | `{meteredOpenCap: 0..1000 \| null}` — `null` = back to the platform's | the same view |
| `GET .../users/:userId/grant-limit` | — | `{userId, own: {meteredOpenCap, reason, setByUserId, updatedAt} \| null, tenantDefault, platformDefault, effective, open}` |
| `PUT` the same | `{meteredOpenCap: 0..1000, reason: 1..500}` | the same view |
| `DELETE` the same | — | the same view, `own: null` |

| Rule | Why |
|---|---|
| `effective` is `meteredCapOf`'s, `open` counts `OPEN_GRANT_STATUSES` metered Grants | the panel shows the number a sale is refused by, never one it computed |
| Reads pass `read`, writes `staffWrite`: a suspended reseller sees its numbers and changes none | the door's matrix, as every write on a user |
| A user the tenant does not hold is **404** `user_not_found`, before anything is read or written; the door's refusals are the user-grants surface's (`resellerRefusal`) | C-15; one set of answers for one door |
| A user's number needs a `reason`; the tenant's takes none. Out of range: **400** `errors.billing.grantLimitInvalid` | the number is a ticket's answer, and the reason is how the next person finds it. 1000 catches a typo; 0 sells none |
| Every change writes `admin_audit_log` in its transaction (`auditLimit`): `grant_limit_tenant_set` against the tenant, `grant_limit_user_set` / `grant_limit_user_remove` against the user, before/after `{meteredOpenCap}`. A change to nothing (same number, removing none) writes no row and is not refused | who raised whom is the question a panel full of seats asks |
| Buckets: reads `RESELLER_USER_GRANTS_READ`, writes `RESELLER_USER_CONFIG_ACTION` | part of reading a user's services, and an admin's act on a user |
| Nobody is notified | it changes what may be bought, not what the user holds |
| A user's number or a tenant default **above the reseller's ceiling** is **409** `reseller_limit_reached`, `errors.billing.grantLimitAboveCeiling`, `facts {key, limit, used}` (`used` = the number asked), **whoever asks** — the platform's staff too; nothing is written. Both views carry `ceiling` (`null`: none) | the ceiling bounds the number in effect anyway, so one stored above it would read as something it is not; the platform's staff raise the ceiling itself, one row (`tenant/contract.limits.md`) |


The panel shows both numbers on the users pages and the shop names the refusal
(F-118-aq, `panel-web/contract.reseller-users.md` rule 24, `contract.shop.md` rule 7a).

Proved by `entitlement/metered-cap.spec.ts` and `payment/gift/grant-limits.spec.ts`.
