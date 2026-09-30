---
id: entitlement
layer: domain
status: draft
version: 28
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

## Not yet

Staff read and set both numbers through F-118-ap; the panel shows them and the
shop names the refusal in F-118-aq. Until then a row is written by hand.

Proved by `entitlement/metered-cap.spec.ts`.
