---
id: panel-web
layer: interface
status: active
version: 42
updated: 2026-10-03
---

# Contract — panel-web: the user's lotteries (F-707-n)

A topic file of [contract.md](contract.md) (§10). Two pages over billing's
lottery routes ([engagement contract](../../domains/engagement/contract.md)
"A user's entry", "The delivery and the result"; ADR-0111 point 5), both
through `lotteryApi` in `lib/engagement-api.ts`:

- `/lotteries` (`PANEL_LOTTERIES`): `(panel)/lotteries/_components/LotteriesView.tsx`.
- `/lotteries/[id]` (`panelLotteryPath`): `LotteryResultView.tsx`.
- The rules: `(panel)/lotteries/_lib/lotteries.ts`.

## Rules

1. **Billing decides who sees, who joins, who got a ticket.** The list is
   billing's; `entryState` only chooses what the card offers: join or leave on
   an open `opt_in` lottery, the "entered automatically" line on an open
   `automatic` one, the ticket or the exclusion's reason after the freeze.
   A published lottery past its close reads "closing" until the freeze.
2. **The verify step is the draw.** `site-pwa/src/lib/lottery-draw.ts` is a
   byte-identical copy of `shared-core/src/lib/engagement/lottery-draw.ts`
   (the site-pwa image builds from its own folder, so it cannot import it);
   the spec fails on any difference. Edit the shared-core file, then copy it.
3. **`verifyDraw` checks three things, in the browser only:** the ticket list
   hashes to `listHash` with `entrantCount` tickets; `lotteryPlaces` over the
   published seed gives every place its ticket; each place holds the prize the
   draw gave it, or is a reserve naming a `passed_on` place whose prize it
   took. An unknown `algorithm` is said, never checked as if known.
4. **Ticket lists carry entrant ids, never users.** The caller's own ticket is
   picked out from `mine`.
5. **Every reason has a sentence:** `EXCLUDED_KEYS` over the close's
   `ExclusionReason`, `REFUSAL_KEYS` over `LotteryEntryRejection`, and
   `result.passedOn` over `PassedOnReason`, each read from the service by the spec.
6. **The menu entry asks nothing** — every signed-in user may open the page.

## Proof

`(panel)/lotteries/lotteries.test.ts` — the copy is shared-core's, a published
result verifies, a pass-on verifies, a changed ticket / swapped places / a
moved prize / another seed fail, an unknown method is named, the status and
entry states, the three reason unions, the menu, every key in `en` and `fa`.
