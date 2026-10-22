---
id: panel-web
layer: interface
status: active
version: 43
updated: 2026-10-22
---

# Contract — panel-web: «تمدید», the renewal sheet on My services (F-305-f/g, ADR-0158)

The user's side of billing's renewal ([contract.renewal.md](../../domains/billing/contract.renewal.md)).
A §10 split of [contract.my-services.md](contract.my-services.md), beside
[contract.own-freeze.md](contract.own-freeze.md) and [contract.self-move.md](contract.self-move.md).
The seller's side is the renewal-rate section of a product's editor (F-305-g, at the
end). **Status: the sheet is built (F-305-f)**; F-305-g adds the custom amount and the
editor, F-305-h the 'renew' links that lead here.

Its pieces: `services/_components/RenewalSheet.tsx` (`Renewal`: the button and the sheet),
`services/_lib/renewal.ts` (`renewalOffered`, `planAdds`), `readGrantRenewed` in
`services/_lib/my-services.ts` (heard by `useGrantsPage`), and the shop's checkout it
shares — `shop/_hooks/useCheckout.ts` and `shop/_components/CheckoutPay.tsx`
([contract.shop.md](contract.shop.md)). Calls: `lib/billing/renewal.ts`.

## Rules

| # | Rule | Why |
|---|---|---|
| 1 | **«تمدید» is on a renewable Grant's row only**: the caller's own, `active` or `suspended`, with a plan (one issued without one is listed nothing), as billing answers it. It opens one sheet (kit `Dialog`, C-13); no other page. Nothing is read until it is pressed | a button that can only be refused is not drawn |
| 2 | **The plans come first, the Grant's own on top**: what each adds (GiB, days; unlimited said as unlimited) and what it costs, from billing's answer (`GET /api/billing/gift/grants/:grantId/renewal-plans`, F-305-j), never computed here. Another plan of the same product is listed beside it, larger or smaller | ADR-0158 (1), (3) |
| 3 | **A plan no longer sold says so** and links the shop; it is never drawn as a choice | the variant is gone, off or unpriced (billing rule 4) |
| 4 | **The custom amount** (F-305-g) is shown only when the product has a rate in effect (`custom` on the plans answer, null = off): GiB and days typed, its bounds shown beside each field, the price read live from billing (`…/renewal-quote?gib=&days=`, F-305-e), never multiplied in the browser. A part the Grant cannot take (unlimited, or metered GiB) has no field | billing rules 5, 6, 8 |
| 5 | **Coupon field and pay from wallet are the shop's checkout**, the same components: one invoice, its 30-minute clock, its shortfall to top-up and back (`contract.shop.md`). Picking another plan cancels the pending invoice and asks the codes again for the new one; closing the sheet cancels it. The top-up's way back is the shop's `?invoice=`, where a renewal invoice pays as it is (shop rule 8) | one way to pay, one set of refusals |
| 6 | **Nothing is patched from the answer**: a paid renewal closes the sheet, and the row re-reads on billing's event (`useLiveReread`, C-14) | no page polls (ADR-0121) |
| 7 | **A refusal stays in the sheet**, as billing's sentence with its ref | refused whole, nothing renewed |

## The seller's rate (F-305-g)

On a product's editor, for the platform and for a reseller (the reseller's door, ADR-0064),
over catalog's [contract.renewal-rate.md](../../domains/catalog/contract.renewal-rate.md) (F-305-b, built):
the rate in effect (price per GiB, per day, the fewest and most of each), its history newest
first, a new rate from a moment, and «خاموش» (custom renewal off) as its own row. The amounts
are in the tenant's pricing currency, named beside them (`GET /pricing-currency`).

## Proof

`services/renewal.test.tsx` — rule 1 (which rows, nothing read before the press), the
plans in billing's order with the own one marked and what each adds and costs, unlimited
said as such, a plan no longer sold said with the shop linked, the picked plan invoiced as
a renewal of this Grant (`grantId` + `variantId`, no figure) and paid, the sheet closed, a
refusal kept in it with its ref, and `entitlement.grant.renewed` read for its Grant only.
The checkout itself is proved by `shop/shop.test.tsx`.
