---
id: panel-web
layer: interface
status: active
version: 33
updated: 2026-09-25
---

# Contract — panel-web: the shop (F-111-e)

`/shop` (`(panel)/shop/`), the sidebar's `buy` entry. What the caller may buy,
then buy -> invoice -> pay from the wallet, over billing's purchase routes
([billing/contract.purchase.md](../../domains/billing/contract.purchase.md)):
`GET /offers`, `POST /invoices`, `GET /invoices/:id`, `POST /invoices/:id/pay`.

Its pieces: `_components/ShopView.tsx` (list, checkout, invoice, paid),
`_lib/shop.ts` (the shortfall, the pre-fill, the grouping, the return id),
`page.tsx` (reads `?invoice=`). The top-up page and `/payment/success` each
carry one piece of the return (rules 5 and 6).

## Rules

1. **Billing prices; the page sends no figure.** The list shows `GET /offers`'
   price, the invoice is made from `variantId` and the typed codes alone, and
   what is paid is the invoice's `total`. A price on screen is never sent back.
2. **The list is billing's, unfiltered here.** `GET /offers` already leaves out
   what an invoice would refuse — unlisted, unpriced, undeliverable — so the page
   never offers a buy that answers `variantNotFound`. Variants are grouped under
   their product in billing's order (`groupOffers`). A name is a `nameKey`
   resolved through the published `catalog` namespace, falling back to the SKU,
   as on My services ([contract.my-services.md](contract.my-services.md) rule 6).
3. **Codes are typed before the invoice.** Billing holds the applied ones under
   the invoice for its 30 minutes, so changing them is a new invoice, not an
   edit. The invoice shows each applied code's discount and each rejected
   code with billing's sentence.
4. **One press pays once.** The claim is a ref taken on the click, before the
   request; the button is disabled while it is in flight. A 409 other than the
   shortfall (`expired`, `already_paid`, `cancelled`) re-reads the invoice, so
   the status on screen and the pay button follow billing's.
5. **A shortfall is billing's figure, and a link.** `insufficient_balance`
   carries `missing` in the envelope's `error.facts` (`ApiError.facts`,
   [contract.errors.md](contract.errors.md)); `shortfallOf` reads it and never
   recomputes it from a balance, so the round-up-to-the-cent rule (F-111-c)
   lives only in billing. The link is `panelDepositForInvoicePath(id, missing)`.
   The top-up page ([contract.deposit.md](contract.deposit.md) rule 18)
   pre-fills `missing` raised to the chosen gateway's `minAmount`
   (`prefillAmount`, exact decimal compare, C-02) and links back.
6. **Back to the same invoice.** `/shop?invoice=<id>` opens on
   `GET /invoices/:id` instead of the list — its price and its held codes, not
   a new invoice. The bank returns to `/payment/success`, which has no other
   way to know, so the top-up page keeps the id in **session** storage and the
   success page offers "continue your purchase" while it is there
   ([contract.payment-result.md](contract.payment-result.md)); the shop forgets
   it once the invoice is paid. Only the id is kept — never a code or a figure.
7. **An invoice that is not `pending` offers no pay.** Every `InvoiceStatus`
   has a sentence (`common.shop.invoice.status.*`, keyed by the union
   `INVOICE_STATUSES`, which mirrors `billing.prisma`). A `pending` one past its
   clock reads `expired` from billing already.
8. **The key is shown once, then My services.** The pay answers each Grant's
   `token` in the clear this one time (D-35); it is shown with the gift modal's
   own sentences and never kept, and the page points to My services, where a
   lost key is asked for again. A paid Grant is `pending` until delivery —
   "being prepared" — and turning it active live is F-111-f.

## Proof

`shop/shop.test.tsx` — the shortfall read from `facts` and nothing else, the
pre-fill never lowered below `missing`, the grouping, an invoice made from the
variant and codes alone, the top-up link carrying the invoice and `missing`,
the key once with the My services link, one pay per press, and the return on
`?invoice=` — pending pays, expired does not.

## Not covered

Delivery status live on My services (F-111-f). Buying inside the bot (bot-app).
A metered variant's first block is bought by the Grant's own flow, not here.
