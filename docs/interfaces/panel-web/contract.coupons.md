---
id: panel-web
layer: interface
status: active
version: 18
updated: 2026-09-14
---

# Contract — panel-web: coupons and gift codes (F-502-g, F-502-h)

A topic file of [contract.md](contract.md) (§10). One page, `/coupons`
(`PANEL_COUPONS`), under `(panel)/coupons/`: `page.tsx` is a server shell,
`_components/CouponsView.tsx` the two tabs, `CouponForm.tsx` the create/edit
sheet, `CouponUsage.tsx` the usage report, and `_lib/coupon-form.ts` the rules.
The routes, the scope and every rule are
[billing/contract.coupon.md](../../domains/billing/contract.coupon.md)'s
(F-502-c..f, ADR-0048).

## Rules

1. **The permission hides it; billing scopes it.** The menu entry (`financial`
   group) `requires: ["coupon.manage"]`. What is listed — the platform owner
   every coupon, a tenant its own — is billing's answer. The owner's scope
   filter (everyone's / platform / a tenant id) only narrows it; a reseller
   never sees the filter.
2. **One sentence per refusal.** `REFUSAL_KEYS` is a `Record` over
   `CouponRejection`, and the test reads that union from
   `coupon-admin.service.ts`. `refusalKey(e)` picks it from `ApiError.reason`;
   anything else falls back to `useApiErrorMessage`.
3. **The form mirrors billing** (`validateCouponForm`): code
   `[A-Z0-9][A-Z0-9_-]{2,39}` upper-cased, value > 0 and a percentage ≤ 100, a
   cap on a percentage only, min ≤ max purchase, whole numbers, hour and period
   pairs both-or-neither, end after start, targeted needs at least one user id,
   every id a uuid, and on an edit total uses ≥ used + reserved.
4. **A picked day is Tehran's.** `validFrom` is that day's first instant at
   `+03:30`; `expiresAt` the next day's first instant, so the day picked is
   included (`dayToInstant` / `instantToDay`). The weekday and hour gates read
   the same clock (F-502-k).
5. **An edit sends only what changed** (`updateBody`), so a used coupon's type
   and value are never restated; the sheet shows them disabled with a note
   (`isUsed`). A set sent replaces the whole set, as billing reads it.
6. **Owner-only fields.** The owner picks whose coupon on create (`own`,
   `platform` = `tenantId: null`, another tenant's id); a platform coupon shows
   the served-tenants box and only platform gateways. Nothing owner-only is
   sent for a reseller.
7. **Nothing is patched from an answer.** Save, toggle and delete re-read the
   list; a delete says whether the coupon is gone or hidden because used.
8. **Status tones are theme tokens, never gold** (`STATUS_TONES`, one per
   `CouponStatus`, test-checked against billing's union).
9. **Usage** opens billing's report for the coupon: totals (redemptions, used,
   on hold, released, discount given) then each redemption, paginated. A
   deleted coupon keeps only this action. **Filters (F-502-i):** a status from
   `REDEMPTION_STATUSES` (test-checked against Prisma's `RedemptionStatus`) and
   a Tehran day range — `from` the day's first instant, `to` its **last**
   (`23:59:59.999+03:30`), since billing reads `to` as `lte`. A new filter goes
   back to page 1; a range ending before it starts is said, not sent. Billing's
   totals follow the range and ignore the status, and the view says nothing
   more about them than billing does.

10. **Gift codes (tab 2, F-502-h) are never on screen.** Generating answers
    the batch (label, counts), not its codes; "Download CSV" fetches
    `{filename, csv}` on the click, `downloadText` builds the file with a BOM
    and revokes its object URL at once, and billing audits the export. A batch
    form mirrors billing: a name, 1..5000 codes (`GIFT_BATCH_MAX`, test-checked
    against the service), a value > 0, an optional prefix of up to 8 letters or
    digits, an inclusive Tehran end day; owner fields as rule 6.
11. **Switching a batch off is confirmed and re-read.** The sentence says how
    many codes went off; codes already redeemed keep their credit. Usage opens
    the same report view as a coupon's, with the batch's totals.

## Proof

`coupons/coupons.test.ts` — refusal and status unions against the service
source, `validateCouponForm` per rule, `createBody` (reseller vs owner, days,
limits), `updateBody` (only changes, null clears), the Tehran day round trip,
the menu permission, the usage filter (`usageQuery`, `validateUsageFilter`,
statuses against Prisma), every key in `en` and `fa`.
`coupons/gift-codes.test.ts` — `validateGiftBatch` per rule and against
`GIFT_BATCH_MAX` in the service, `giftBatchBody` (reseller vs owner, prefix,
inclusive day), every gift key in `en` and `fa`.
