---
id: entitlement
layer: domain
status: draft
version: 27
updated: 2026-09-30
---

# Entitlement — a reseller's package plan, bought wholesale (F-118-p)

A package plan (paid in full at purchase, its bytes in `purchasedBytes`) that a
reseller sells is charged its bytes at the reseller's package rate for
`vpn.traffic`, on the reseller's `tenant_billing_wallet`. ADR-0105 decision 0,
amended 2026-09-29 (user): the **user's** path is untouched — no meter, no
hold, no read of the user's wallet after the sale; only the reseller's side is
added. D-58. A metered Grant's wholesale leg is F-118-n3 (billing
`contract.traffic-block.md`); a Grant has one or the other, never both.

Code: `billing-service/src/app/entitlement/package-wholesale.ts`
(`PackageWholesale`), proved by `package-wholesale.spec.ts`.

## The leg

`grant_wholesale` (`data-model.md`), one row per such Grant, written by
`GrantService.issue`: the payer (the Grant's tenant), the package's
`tenant_package_meter_rate` for `vpn.traffic` in force at `startsAt` (tenant
`contract.admin.md`, `meterRates`), in the platform's currency, and two cursors
in bytes — `billed` (what the reseller paid for) and `consumed` (bytes of the
Grant served on **platform-owned** panels, advanced by `metering-service`,
billing `contract.metering.md`).

No row for: the platform's own sales and a metered Grant. A plan sold with no
row (before F-118-p, or with no rate on its own panels) gets one at its next
renewal — below; no backfill. An unlimited plan's row buys days, not bytes —
below. `meterKey` says which: `vpn.traffic` or `vpn.unlimited.time`.

## A plan sold before its leg locks at its next renewal (F-118-ab, D-59 (e))

`renewGrant` → `lockAtRenewal`, before the renewal moves the plan: the
package's rate in force **at the renewal** is locked as at a sale, and the
renewal's own `settle` / `renew` charges from there on. Nothing for the past:

- **A bag**: what it still held (`purchasedBytes − consumedBytes`, ≥ 0) is
  `inherited` and starts `billed` — counted as bought, so only what the
  renewal adds is charged. At close, bytes served draw on it first and it
  never comes back: the refund is `billed − max(consumed, inherited)`.
- **An unlimited plan** inherits nothing: its days left come first, so the
  close's give-back (`min(days left, billed)`) already keeps them. A plan with
  no end sells no days at a renewal and locks nothing.
- The sale's checks hold (rules 3, 4): no rate on a platform panel refuses the
  renewal `wholesale_rate_missing`; on the reseller's own panels it renews with
  no leg, and the next renewal tries again. An admin's raise, reset or added
  days on a plan with no leg still buys nothing — only a renewal locks.

## An unlimited plan buys its days (F-118-z, D-59 (c))

An unlimited plan (`trafficUnlimited`) has no bag, so it locks the package's
`vpn.unlimited.time` rate instead — a flat price per period, `unitSize` seconds
(30 days = 2 592 000), set in `meterRates` like any wholesale rate (tenant
`contract.admin.md`). Charged pro rata to the days sold (user, 2026-09-30:
a 90-day plan is 3 periods, a 15-day renewal half of one), priced **up** to a
cent, `billed` counting the seconds; `consumed` stays 0 (metering advances only
a `vpn.traffic` leg).

- **Sale** (`open`): `endsAt − startsAt`, naming the Grant. **Renewal**
  (`renewGrant` → `renew`): the days added, naming the renewal's record
  (`grant_renewal.id`, chosen before the row). **An admin's added days**
  (`changeGrantDuration` → `extend`, `contract.admin.md`): the seconds the end
  moved, naming the `grant_duration_change` row — as rule 2 buys an admin's
  raise of a bag. A cut buys nothing and gives nothing back until close.
- Charged only when the group holds a platform panel **now**; the rate is
  locked whenever the package has one. Rules 3 and 4 hold as for a bag:
  `wholesale_unfunded` rolls the act back; no `vpn.unlimited.time` rate, **or a
  plan with no end** (user, 2026-09-30: no period to price), is
  `wholesale_rate_missing` on a platform panel and sells with no leg otherwise.
- **At close, the days left come back** (`settleAtClose`): the seconds from
  the close to `endsAt`, never more than `billed`, as `metered_usage_refund`
  naming the Grant, priced **down** (an admin's delete mid-period, a failed
  delivery). A Grant closed after its purge has none left. `consumed` is raised
  to the lowered `billed`: on this leg that equality means settled, so a second
  close moves nothing. `settle` moves nothing on this leg.

## Rules

1. **Bought with the bag.** After the bag moves, `billed` is raised to
   `consumed + (purchasedBytes − consumedBytes)` when the variant's panel group
   holds a platform panel **now**, else to `consumed`; never lowered before
   close. The difference is one `metered_usage_charge`, price rounded **up** to
   a cent, `billed` moved by every byte those cents pay for. A byte bought
   ahead and served by the reseller's own panel funds the next platform byte
   (the F-118-n3 formula on a bag bought whole).
2. **Every raise of the bag buys** (user, 2026-09-29): the sale
   (`issue`, any source — purchase, gift code, admin issue; `referenceId` =
   the Grant), a renewal (`renewGrant`, a forgiven debt included) and an
   admin's raise or reset (`adjustGrantTraffic` with a positive delta,
   `resetGrantTraffic`); `referenceId` = the `quota_adjustment` row. A cut buys
   nothing and gives nothing back until close.
3. **Unpaid is unsold** (user): a reseller whose balance is below the price is
   refused `wholesale_unfunded` and the whole act rolls back — the wallet never
   goes negative (§5.4).
4. **No rate, no platform panel** (user): a package pricing no `vpn.traffic` is
   refused `wholesale_rate_missing` only when the group holds a platform panel
   at the sale; on the reseller's own panels the plan sells with no leg. The
   rate is locked whenever the package has one, so a platform panel added to
   the group later is still charged at the next raise.
5. **Settled at close, both ways** (user; D-59 (d), F-118-y). Only for a
   closed Grant (`cancelled`, `expired`, `exhausted`), by `settleAtClose`:
   - `billed > consumed`: `billed − consumed`, priced **down**, as
     `metered_usage_refund` naming the Grant, `billed` to `consumed` — or to
     `inherited` when that is higher (F-118-ab: held bytes never come back);
   - `consumed > billed` (a platform panel joined the group after the last
     raise): those bytes charged as `metered_usage_charge` naming the Grant,
     priced **up**, as far as the reseller's balance covers them
     (`coverable`, `usage-wholesale.ts`). What it cannot cover stays below the
     cursor and is logged (`RemainderCreditService.wholesaleAtClose`) — never a
     negative wallet (§5.4), never a debt row.

   The cursor is the guard, so a second close moves nothing. Run by the close
   stage ([contract.close.md](contract.close.md)), an admin's delete (whatever
   the admin answered about the user's remainder) and a failed delivery's
   refund (`delivery.ts`). A plan whose days or bag ran out is `suspended` and
   renewable, not closed: it keeps what it bought.

## What each surface answers

| Surface | `wholesale_rate_missing` / `wholesale_unfunded` |
|---|---|
| reseller admin routes (issue, renew, traffic, reset; billing `contract.reseller-grants.md`) | 409, `resellerUsers.grant.refusal.<reason>` |
| a user paying an invoice (billing `contract.purchase.md`) | 409, `errors.billing.invoice.variantNotFound` — the buyer is told only that it is not for sale |
| a gift code for a free service | passes through, as the other issue refusals do there |

## Known gaps

- **Bytes a reseller could not pay for at close** are only logged: the gap
  `consumed − billed` on the closed Grant's leg is the record, and nothing
  collects it later (F-118-y).
