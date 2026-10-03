---
id: bot-app
layer: interface
status: active
version: 13
updated: 2026-10-03
---

# Contract — bot-app: lotteries in the chat (F-707-p)

A topic file of [contract.md](contract.md). `flows/lottery.flow.ts`, the
`🎟 Lotteries` row on the member menu (`ACTIONS.lotteries`), and four calls in
`billing-api/billing-api.client.ts` — the panel's own `GET /api/billing/lotteries`,
`POST` / `DELETE …/:id/entry` and `GET …/:id/result`, through the gate
(ADR-0009). The rules they serve are engagement's
([contract.md](../../domains/engagement/contract.md) "A user's entry", "The
delivery and the result"; ADR-0111 points 5, 6).

## Rules

1. **The bot decides nothing.** Which lotteries a user sees, who may join and
   who got a ticket are billing's; the screens show it.
2. **The row is behind billing's reachability**, as the wheel's
   (`BillingApiClient.isConfigured`). No lottery is `lotteries.none`.
3. **List, then card.** The list is one button per lottery (at most 10), the
   title as the tenant wrote it and its status. The card: status (a cancel
   with the admin's public reason), the time left as a span (no zone needed),
   the prizes `rank. label ×winners`, and the user's entry.
4. **Join only where billing takes it** — an open `opt_in` lottery with no
   entry; Leave only to one who joined; Result only once `drawn`. After a
   join or leave the card is read again, so it shows billing's answer.
5. **Every button names its lottery** (`lot:<o|j|l|r>:<id>`, 42 bytes, under
   the 64-byte callback cap) and needs no state: a tap on an old screen still
   means what it says. The router sends the prefix to the flow from any state.
6. **Every reason has a sentence**: the close's `ExclusionReason` and the
   entry routes' `LotteryEntryRejection`, read from billing by the spec; an
   unknown one falls back to billing's translated `msg`.
7. **The result is the prize places and their delivery** (✅ given, ⏳ being
   given, ↪️ passed on, `(n)` took over place n) and whether the user's ticket
   won. The check of the draw is the panel's (F-707-n); the copy says so.
8. **The winner's message is F-707-m's `lotteryWon` notice** (class
   `important`: the inbox and one messenger), not this flow.

The announcement of a newly published lottery to its group is not built:
it is a send to a whole group, F-707-q.

## Proof

`flows/lottery.flow.spec.ts` — the list and its buttons, none, the card's
entry and buttons per state, an exclusion and a cancel's reason, join through
billing and the card read again, a refused and an unknown refusal, the result
and the user's own outcome, `not_drawn`, both unions, the callback length.
`locale/bot-copy.spec.ts` holds the new keys in `en`, `fa` and the fallbacks.
