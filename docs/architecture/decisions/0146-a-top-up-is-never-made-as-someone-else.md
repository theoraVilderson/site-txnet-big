---
id: adr-0146
status: active
updated: 2026-10-14
---

# ADR 0146 — A top-up is never made as someone else

- **Status:** accepted (DIAGNOSE fix, 2026-10-14)
- **Date:** 2026-10-14
- **Decision:** the user's (2026-10-14: "a principled design that later
  updates and features will not break")
- **Affects units:** forward-auth, identity, panel-web
- **Amends:** ADR-0136 item 4 — "deposit" leaves the list

## Context

ADR-0136 put the whole deposit flow on the impersonation list. On 2026-10-14
an admin signed in as a user, topped up, and came back from the gateway on
their own panel: the payment row and the credit were the user's (correct),
but the result page was the admin's, so it read as "it charged me".

Nothing leaked; the design did. An impersonation lives in one tab's memory
(`contract.reseller-users.md` rule 31). A bank gateway is a full-page
navigation, so it always ends the impersonation, and the page it returns to
always loads as the admin. Every gateway added later has the same shape. And
a card or crypto payment in the person's name is their own act: an admin
paying it with their own instrument makes the ledger say the user paid.

## Decision

1. **The person's own payment is never made by someone signed in as them.**
   `contracts/http/impersonation.json` drops the four `/api/billing/deposit`
   rows and lists the prefix under `never`, so a deposit route added later is
   closed too — `tools/contracts.py` refuses an `allow` row under it.
2. **Paying an invoice from the wallet stays** (`/invoices/:id/pay`): it moves
   the person's existing balance and never leaves the tab.
3. **The panel says it once, per own-act page.** The top-up page and buying
   a reseller (`/resellers/buy`, whose `POST /api/tenants/purchase` was
   already `never` as "plans") render `OwnActOnly` while impersonated — one
   title, and the page's own `why` — so every link lands on one sentence; a
   menu entry marked `ownActOnly` is dropped by `impersonationMenu`. The start
   dialog names top-ups among what stays closed.

## Consequences

- A support admin cannot top up for a user. Credit given by staff needs its
  own audited path (a gift coupon today), not a payment in the user's name.
- A future own-act page (a payout, a crypto send) is marked `ownActOnly`, and
  its routes go under `never`, in the change that builds it.

## Alternatives rejected

- **Keep it, warn before the gateway and name the payer on the result page.**
  Every result page and every new gateway must then know about impersonation,
  and the admin still comes back as themselves — the confusion stays, only
  better worded.

## Revisit trigger

An impersonation that survives a navigation (a server-held session the
gateway's return can resume) — then the tab argument is gone, though the
own-instrument one stays.
