---
id: panel-web
layer: interface
status: active
version: 34
updated: 2026-09-30
---

# Contract — panel-web: the shop (F-111-e, rebuilt by F-114-d)

`/shop` (`(panel)/shop/`), the sidebar's `buy` entry. What the caller may buy,
laid out to compare, then one page to pay from the wallet, over billing's
purchase routes ([billing/contract.purchase.md](../../domains/billing/contract.purchase.md)):
`GET /offers`, `POST /invoices`, `GET /invoices/:id`, `POST /invoices/:id/pay`,
`POST /invoices/:id/cancel`.

Its pieces: `_components/ShopView.tsx` (cards, checkout, paid),
`_lib/shop.ts` (the shortfall, the pre-fill, the grouping, the tabs, a quota's
limit, the return id),
`page.tsx` (reads `?invoice=`). The top-up page and `/payment/success` each
carry one piece of the return (rules 7 and 8).

## Rules

1. **Billing prices; the page sends no figure.** The list shows `GET /offers`'
   price, the invoice is made from `variantId` and the typed codes alone, and
   what is paid is the invoice's `total`. A price on screen is never sent back.
2. **The list is billing's, unfiltered here.** `GET /offers` already leaves out
   what an invoice would refuse — unlisted, unpriced, undeliverable — so the page
   never offers a buy that answers `variantNotFound`. A name is a key resolved
   through the published `catalog` namespace, falling back to the SKU (a
   category's to its key), as on My services
   ([contract.my-services.md](contract.my-services.md) rule 6).
3. **One card per product, to compare** (F-114-d). `groupOffers` keeps billing's
   order. The card is headed by `productNameKey`; its variants are a radio
   group of chips — a variant's own name when it has one, else its term, plus
   its traffic when siblings differ on it — and the picked one's facts (term,
   traffic, devices, "pay as you use" for `metered`: only what the catalog set,
   `quotaLimit`) and price sit on the card over one buy. Tabs (`categoriesOf`,
   "All" first) only when the offers span more than one category.
   **A metered card is priced by its rate** (F-118-af): with a `vpn.traffic`
   card per 2^30 bytes in the offer's `rateCards` (`trafficRateOf`), the
   figure is its `unitPrice` "per GB" — never the sale's 0.00 — with any
   upfront price under it, and the fact says paid ahead (`prepaid`) or held
   and taken after (`postpaid`). No such card: the plain price and "pay as
   you use".
4. **Checkout is one page; no invoice for looking** (F-114-d). The order, the
   codes, the figures, what the wallet can spend (`available`, F-118-j) and pay sit together. An invoice is
   made when a code is applied (to show billing's discount) or on the pay
   press. A code not applied is dropped from the chips and shown with billing's
   sentence. A total made on the pay press that differs from what was on
   screen is shown, not paid — the second press pays it.
5. **An invoice replaced or left is cancelled first** (F-114-d). A code held
   by an unpaid invoice counts as a use for 30 minutes, so a new invoice beside
   it refuses a one-use code: a change of codes, and going back to the list,
   send `POST /invoices/:id/cancel` for the pending one before anything else.
   Best effort — its clock frees the holds anyway.
6. **One press pays once.** The claim is a ref taken on the click, before any
   request — it covers the invoice made on the press too; the button is off
   while it is held. A 409 other than the shortfall (`expired`,
   `already_paid`, `cancelled`) re-reads the invoice, so the status on screen
   and the pay button follow billing's.
7. **A shortfall is billing's figure, and a link.** `insufficient_balance`
   carries `missing` in the envelope's `error.facts` (`ApiError.facts`,
   [contract.errors.md](contract.errors.md)); `shortfallOf` reads it and never
   recomputes it from a balance, so the round-up-to-the-cent rule (F-111-c)
   lives only in billing. The link is `panelDepositForInvoicePath(id, missing, currency)`,
   `currency` the invoice's own, as every figure on the page is in its answer's (F-116-h3).
   The top-up page ([contract.deposit.md](contract.deposit.md) rule 18)
   pre-fills `missing` raised to the chosen gateway's `minAmount`
   (`prefillAmount`, exact decimal compare, C-02) and links back.
8. **Back to the same invoice.** `/shop?invoice=<id>` opens on
   `GET /invoices/:id` instead of the list — its price and its held codes, not
   a new invoice. The bank returns to `/payment/success`, which has no other
   way to know, so the top-up page keeps the id in **session** storage and the
   success page offers "continue your purchase" while it is there
   ([contract.payment-result.md](contract.payment-result.md)); the shop forgets
   it once the invoice is paid or replaced. Changing the codes there cancels
   it and makes a new one for the same variant (rule 5). Only the id is kept —
   never a code or a figure.
9. **An invoice that is not `pending` offers no pay.** Every `InvoiceStatus`
   has a sentence (`common.shop.invoice.status.*`, keyed by the union
   `INVOICE_STATUSES`, which mirrors `billing.prisma`). A `pending` one past its
   clock reads `expired` from billing already.
10. **No key, then My services** (F-114-e-c, ADR-0085). The pay answers no
   token (billing, F-114-e-c). The page says the service is being
   prepared and that its subscription link is in My services, and links there.
   A paid Grant is `pending` until delivery — "being prepared" — and My
   services turns it active live
   ([contract.my-services.md](contract.my-services.md) rule 13, F-111-f).

## Proof

`shop/shop.test.tsx` — the shortfall read from `facts` and nothing else, the
pre-fill never lowered below `missing`, the grouping and the tabs, a chip
picking the variant bought, no invoice until a code or the pay, a changed
total not paid, the replaced invoice cancelled before the next is made, a
rejected code dropped, the top-up link carrying the invoice and `missing`, no key
shown, only the My services link, one pay per press, and the return on
`?invoice=` — pending pays, expired does not.

## Not covered

Buying inside the bot (bot-app).
A metered variant's first block is bought by the Grant's own flow, not here.
