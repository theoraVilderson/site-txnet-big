---
id: bot-app
layer: interface
status: active
version: 19
updated: 2026-10-22
---

# Contract — bot-app: «تمدید» in the chat, renewing one's own service from the wallet (F-305-i)

A topic file of [contract.md](contract.md), beside [contract.services.md](contract.services.md).
The panel's renewal sheet ([panel-web/contract.renewal.md](../panel-web/contract.renewal.md))
over billing's own routes, through the gate (ADR-0009; server rules: billing
[contract.renewal.md](../../domains/billing/contract.renewal.md)). `flows/renewal.flow.ts`,
its buttons `flows/renewal-actions.ts`, the calls `BillingApiClient.renewalPlans`,
`createRenewalInvoice`, `payInvoice`, `cancelInvoice` (`billing-api/renewal.types.ts`).

**Paid from the wallet only** (user, 2026-10-22): no in-chat gateway, so it waits on no
F-304. A short wallet goes to the chat's own top-up (F-306-a) and back to the same invoice.

## Rules

| # | Rule | Why |
|---|---|---|
| 1 | **«🔄 تمدید» is on a service's screen** when the panel would draw it (`renewalOffered`: `active` or `suspended`, with a plan), first among its buttons | panel-web rule 1: a button that can only be refused is not drawn |
| 2 | **The plans are billing's** (`GET …/gift/grants/:id/renewal-plans`), in its order, the own one marked ⭐: name, what it adds (bytes as the notices say them, days; unlimited said), price before any code. A plan no longer sold is said (`renewal.notSold`). Then «➕ افزایش حجم» / «📅 افزودن روز» for each part the Grant's rate sells (its most > 0) | billing rules 2–6; the chat offers only what the invoice takes |
| 3 | **Every button names its Grant or invoice** (`rnw:<kind>:<id>[:<plan>]`, ≤ 64 bytes) and is routed from any state. A plan is its place in billing's list — two uuids pass the cap — so a stale tap is read against the list *now*; one no longer there shows the list again, and the invoice names what it bought before anything is paid | contract.services.md rule 7 |
| 4 | **GiB or days typed** is the one part asked, its bounds billing's: digits in any script, a whole number, else asked again. Out of bounds is billing's sentence (`custom_out_of_bounds`) with the question still open | billing rule 5 |
| 5 | **The invoice is billing's**: plan, what it adds, price, discount, total, how long it is valid (its `expiresAt`), and a code billing refused in its words. Buttons: pay from the wallet, a code, cancel | billing rules 7–9; nothing is priced here |
| 6 | **A code is typed for the invoice on screen only**: it gives that invoice up and asks billing for the same choice with the code (codes apply at create). The choice is navigation state (ADR-0010), never a price; a code from an old screen sends nothing (`renewal.stale`). One code at a time | ADR-0010 |
| 7 | **Paying**: on success the amount paid and the balance left, and the way back to the service, read again from billing. `insufficient_balance` says the `facts.missing` and offers the top-up and «🔁 دوباره پرداخت» on the same invoice; any other refusal is billing's sentence | billing rule 13, `contract.purchase.md` "The shortfall" |
| 8 | **A renew notice opens it**: auth-service puts «🔄 تمدید» (`renewalOpenCallback`, shared-core) under `serviceEnded`, `serviceVolumeSpent` and `servicePurgeSoon` when the notice names one Grant (`grantId` param, worker-service's `RETENTION_NOTICES`). A metered or capped stop is answered by a top-up or the cap, a combined notice by none | F-601-b, F-601-j |

## Proof

`flows/renewal.flow.spec.ts` — the callback cap and shared-core's open id, rule 1's statuses,
the plans in billing's order with the own one marked and the typed parts, not sold, billing's
refusal, a service gone; a plan invoiced with no figure, a stale place, GiB typed in Persian
digits and a non-number, out of bounds kept asking, a code re-invoicing the same choice and its
refusal, a code from an old screen, cancel; paid, a short wallet, another refusal; signed out.
`flows/services.flow.spec.ts` the card's button. auth-service `notify/notice-buttons.spec.ts`
rule 8; worker-service `retention-notice.consumer.spec.ts` the `grantId` param.

## Not covered

Paying the invoice straight through a gateway in the chat (F-304). Several codes on one invoice.
