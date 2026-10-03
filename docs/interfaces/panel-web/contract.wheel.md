---
id: panel-web
layer: interface
status: active
version: 42
updated: 2026-10-03
---

# Contract — panel-web: the lucky wheel (F-707-g)

A topic file of [contract.md](contract.md) (§10). A page over billing's
`engagement/` routes ([engagement contract](../../domains/engagement/contract.md),
ADR-0111), through `lib/engagement-api.ts`:

- `/wheel` (`PANEL_WHEEL`), under `(panel)/wheel/`: `WheelView.tsx` the page,
  `WheelDisc.tsx` the drawn wheel, `_lib/wheel.ts` the rules.

## The user's wheel (F-707-g)

1. **Billing decides; the page animates.** `GET /wheel` says whether this user
   may spin and why not; `POST /wheel/spin` picks. The wheel turns to the
   `position` billing answered (`landingRotation`: slot 1 starts at the pointer,
   slots run clockwise, five whole turns). Nothing under `wheel/` draws a random
   number — the spec greps for it.
2. **One tap, one spin.** A tap's `requestId` is kept after a lost answer (no
   `reason`, or `spin_in_progress`), so the retry is answered with the spin it
   may have made (engagement "The spin" rule 1); any other answer starts a new key.
3. **The odds shown are billing's** `oddsPercent`, never recomputed here.
4. **Every reason has a sentence**: `REFUSAL_KEYS` covers `SpinRefusalReason`
   and `WheelSpinRejection`, read from the service by the spec. `no_wheel` on
   the read is a page state, not an error.
5. **History is the caller's own** (`GET /wheel/history`, newest 30); a won
   coupon is shown with its code, so a code missed on the result is not lost.
6. **The menu entry asks nothing** — every signed-in user may open the page.

## Proof

`wheel/wheel.test.ts` — the refusal unions, the menu for a plain user, landing
on every slot of 2..16 from any start, no randomness under `wheel/`, the tap's
key, the result sentence, every key in `en` and `fa`.
