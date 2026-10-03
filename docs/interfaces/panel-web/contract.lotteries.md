---
id: panel-web
layer: interface
status: active
version: 42
updated: 2026-10-03
---

# Contract — panel-web: lotteries, the user's (F-707-n) and the admin's (F-707-o)

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

## The admin's pages (F-707-o)

Over billing's `/api/billing/engagement/lotteries` ([engagement contract](../../domains/engagement/contract.md)
"The lotteries' settings", rules 1–10) through `lotteryAdminApi`:

- `/lotteries/manage` (`PANEL_LOTTERIES_MANAGE`): `manage/_components/LotteryAdminView.tsx` — the list, a new draft.
- `/lotteries/manage/[id]` (`panelLotteryManagePath`): `LotteryAdminDetail.tsx` — the lottery, its acts, who enters, the winners.
- The form: `LotteryEditor.tsx`. The rules: `manage/_lib/lottery-admin.ts`.

1. **The menu entry asks `engagement.manage`**, the guard's key, as the
   wheel's settings; RLS keeps each tenant to its own.
2. **Only the acts billing takes in the status are offered** (`actionsFor`):
   a draft is edited, deleted or published; an open one only cancelled, with a
   reason users are shown; after the freeze nothing. Publish and delete ask
   first.
3. **The close is typed on the admin's wall clock in their resolved zone**
   (`displayZone`, [contract.kit.md](contract.kit.md) TZ-1-e) and sent as an
   instant (`wallClockToInstant`); the 1 h – 180 day window is checked before
   the call, and again by billing at save and publish.
4. **No cash, no empty prize is offered**; each kind carries its own fields
   and nulls for the rest, the `.strict()` body's keys only.
5. **"Who enters" is billing's count**: an estimate until the freeze, said as
   one, then the frozen list. Excluded counts have a sentence per close
   reason (`EXCLUDED_COUNT_KEYS`, typed by the close's union).
6. **Winners only once drawn**: each place, its ticket, its user, the prize or
   "reserve", the delivery and a pass-on's reason, and whom a reserve replaced.

Proof: `manage/lottery-admin.test.ts` — the refusal union and the schema's
bounds read from billing, the menu, the zone round trip, the form and its
body, a draft reopened, the acts per status, every key in `en` and `fa`.
