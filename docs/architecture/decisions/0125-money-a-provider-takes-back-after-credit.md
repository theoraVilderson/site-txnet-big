---
id: adr-0125
status: active
updated: 2026-10-06
---

# ADR 0125 — money a provider takes back after it was credited

- **Status:** accepted (nothing built yet — rows CB-1-a..p)
- **Date:** 2026-10-06
- **Affects units:** billing (wallet, deposit webhook door, settlement), entitlement (freeze), panel-web, bot-app, automation (notices)
- **Decision:** the user's, 2026-10-06 (D-61): "flag it, tell the admin, and do
  not let them use it — take back what is still in the wallet, cut what was
  bought with it, keep what they had before" and "make sure nobody can dispute,
  get the money back, and keep topping up"
- **Spec:** [billing/contract.disputes.md](../../domains/billing/contract.disputes.md)

## Context

A card or PayPal payer can open a dispute after the top-up is in their
wallet, and get the money back. Today no gateway hears it: F-092-ae closes a
payment `reversed` only while it is still open, and the webhook door ignores a
reversal of a settled row (`contract.webhook.md`). The wallet keeps the
credit, the services bought with it keep running, and nothing stops the same
person from doing it again. Selling VPN access is exactly where this abuse is
common.

## Decision

1. **One engine, every reversible gateway.** A driver says whether its payer
   can take money back (`reversible`: PayPal, Stripe, Airwallex yes; rial,
   crypto, in-chat no — required on the port). The driver only translates its
   provider's events into four port events (`dispute_opened`, `dispute_won`,
   `dispute_lost`, `refunded`); the money rules live once, in billing's
   `DisputeService`.
2. **The disputed share is taken back from the wallet, as far as it goes.**
   On `dispute_opened` the share is **held** (`wallet_hold`, ADR-0105 (6)) up
   to the free balance; on a loss the hold is **captured** as a
   `payment_chargeback` debit; on a win it is released. What the wallet could
   not cover is the **shortfall** — money that was already spent.
3. **A shortfall locks the account until it is paid.** While the wallet's
   `disputeShortfall` > 0: every credit pays it first; the user's own debits
   are refused (`wallet_locked_dispute`); every active Grant of theirs is hard
   frozen with reason `payment_dispute` (clock not stopped). The lock lifts
   itself when the shortfall reaches zero — paid, the dispute won, or an
   admin's write-off. Money the user had before the top-up is not protected
   from the shortfall: it covers what they spent first ("keep what they had
   before, and take what they used out of it" — the user's words).
4. **One lost dispute bars the reversible gateways.** A user with an open
   dispute, or with a lost one, is offered no reversible gateway and `start`
   refuses one (`gateway_restricted_dispute`); crypto, rial and manual
   transfers stay. The bar is a `dispute_restriction` row an admin lifts with
   a reason. A seller's own refund never bars anyone.
5. **People are told, nothing is silent.** Every dispute event is an outbox
   event: the user is told why their money is held or their services are
   frozen, the tenant's admins are told (and the gateway's owner when it is
   not the user's tenant), and the pages re-read live (ADR-0121).

## Consequences

- A payment stays `success`; its dispute rows say what was taken back. The
  ledger never rewrites a credit.
- `payment_chargeback` and `payment_refund` undo a `payment_gateway` credit in
  revenue and analytics (`UNDOES`), so a reseller's sales fall by the money
  they lost.
- A granted gateway's settlement entry (invariant 13) is reversed or
  counter-entered, so the lending tenant is not paid twice for money the
  payer took back.
- Freezing Grants depends on F-0401-a/d (hard freeze) being built first.

## Rejected

- **A negative wallet balance**: breaks invariant 21's CHECK and every debit
  path's arithmetic; a separate `disputeShortfall` says the same thing without
  pretending the money is there.
- **Freezing only the services "bought with that money"**: a wallet does not
  earmark money, so any attribution is a guess. Freezing everything while a
  shortfall exists, and lifting it the moment it is paid, is exact.
- **Banning the user**: a person's call (`identity`), not a payment rule.
