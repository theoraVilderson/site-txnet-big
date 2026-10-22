---
id: panel-web
layer: interface
status: active
version: 42
updated: 2026-10-03
---

# Contract — panel-web: the lucky wheel (F-707-f, F-707-g)

A topic file of [contract.md](contract.md) (§10). Two pages over billing's
`engagement/` routes ([engagement contract](../../domains/engagement/contract.md),
ADR-0111), both through `lib/engagement-api.ts`:

- `/wheel` (`PANEL_WHEEL`), under `(panel)/wheel/`: `WheelView.tsx` the page,
  `WheelDisc.tsx` the drawn wheel, `_lib/wheel.ts` the rules.
- `/wheel/settings` (`PANEL_WHEEL_SETTINGS`), under `(panel)/wheel/settings/`:
  `WheelSettingsView.tsx` (today, tomorrow, the tabs), `WheelWizard.tsx` (a new
  version: `WheelSteps.tsx`, `WheelReview.tsx`), `WheelVersions.tsx`, `WheelReport.tsx`;
  `_lib/wheel-settings.ts` the rules, `_lib/wheel-steps.ts` the steps.

## The user's wheel (F-707-g)

1. **Billing decides; the page animates.** `GET /wheel` says whether this user
   may spin and why not; `POST /wheel/spin` picks. The wheel turns to the
   `position` billing answered (`landingRotation`: slot 1 starts at the pointer,
   slots run clockwise, five whole turns). Nothing under `wheel/` draws a random
   number — the spec greps for it.
2. **One tap, one spin.** A tap's `requestId` is kept after a lost answer (no
   `reason`, or `spin_in_progress`), so the retry is answered with the spin it
   may have made (engagement "The spin" rule 1); any other answer starts a new key.
3. **The odds shown are billing's** `oddsPercent`, never recomputed here —
   this user's own: a slot whose prize cannot reach their services reads 0% (F-707-u),
   with «(به سرویس شما نمی‌رسد)» beside it from billing's `reachable` (`oddsLine`, F-707-v).
4. **Every reason has a sentence**: `REFUSAL_KEYS` covers `SpinRefusalReason`
   and `WheelSpinRejection`, read from the service by the spec. `no_wheel` on
   the read is a page state, not an error.
   The result line names the service GB or days went to (`resultLine`, F-707-y).
5. **History is the caller's own** (`GET /wheel/history`, newest 30); a won
   coupon is shown with its code, so a code missed on the result is not lost.
6. **The menu entry asks nothing** — every signed-in user may open the page.
7. **The prize service** (F-707-s): `_components/PrizeServicePicker.tsx`, here
   and on `/lotteries`, over `GET`/`PUT /api/billing/reward-target`
   (`lib/billing/reward-target.ts`) — which service GB and days won are added
   to. One choice for the wheel and both lottery kinds; «automatic» is `null`.
   Shown only with two services or more a prize can reach; each named as My
   services names it, a days-only or GB-only one marked, then its end date and
   the GB left when capped (F-707-x) — two services of one plan never read alike. It draws billing's
   answer and keeps no choice of its own, so a refusal leaves billing's in
   place with the reason's sentence. A failed read hides it.

## The admin's settings (F-707-f)

1. **The permission hides it; RLS scopes it.** `requires: ["engagement.manage"]`,
   no tenant type: every tenant has its own wheel.
2. **A save is a new version from the tenant's next day** — the page says so
   before the save, and opens the editor on the newest version (the upcoming
   one, else the one in force), so a save restates what it does not change.
   Any version in the list can start the next one. There is no edit and no delete.
3. **Odds and cost are counted as billing counts them** — odds in hundredths, money in the wheel currency's minor units (F-116-s)
   (`BigInt`, never a float — C-02): odds = weight / Σ weight; average per spin
   = Σ weight × cost / Σ weight, half up; how many average spins the cap pays
   for. A form whose average passes the cap is stopped with billing's exact
   comparison (`expected_cost_over_cap`), and a prize dearer than the cap at
   its field (`prize_cost_over_cap`).
   The review also names `highestCostPerSpin` when some users meet a dearer
   wheel — billing leaves out of a user's pick what their services cannot take
   (F-707-u), so the rest come up more often; the cap holds either way. Billing's
   check stays on the all-slots average (F-707-w).
4. **Each kind carries its own fields** (engagement "settings" rule 3): GB > 0;
   whole days ≥ 1; a coupon's percent (0, 100], its template and 1..365 days; a
   free service's variant; an empty slot gives and costs nothing. The body
   sends nulls for the other kinds' fields. `wallet_credit` is never offered.
5. **Pickers fall back to typed ids.** A coupon template is one of the
   tenant's own active discount coupons; a variant comes from
   `coupons/VariantPicker`; a user group from `/auth/user-groups` — each read
   failing (its permission missing) opens an id box instead.
6. **One sentence per refusal**: `REFUSAL_KEYS` over `WheelAdminRejection` and
   `WheelReportRejection`. The report's refusal reasons reuse the user page's sentences.
7. **A new version is a kit `Wizard`** (UX-3-c, [contract.ux.md](contract.ux.md) K12):
   cap and on/off → who may spin → prizes, with the disc drawn by `WheelDisc`
   and each slot's odds → review (the cap, the average per spin, how many
   spins the cap pays for, the day it starts). Next checks only the step's part
   of `validateWheelForm` (`WHEEL_STEP_HOLDS`); a refusal returns to the step
   holding what it names (`WHEEL_REFUSAL_STEP`). A first wheel is offered a
   starter set (`starterPrizes`) while no slot is touched: misses cost 0, and
   each prize's cost is left blank for the admin to type. Closing a changed
   wizard asks first.

## Proof

`wheel/wheel.test.ts` — the refusal unions, the menu for a plain user, landing
on every slot of 2..16 from any start, no randomness under `wheel/`, the tap's
key, the result sentence, every key in `en` and `fa`.
`wheel/settings/wheel-settings.test.ts` — the refusal unions, the guard's key
and schema bounds, the menu, odds in hundredths and the average in the currency's minor units, the cap rules, each
kind's shape, the strict body, the form opened on a version, every key.
`wheel/settings/wheel-wizard.test.tsx` — every checked field on one step, a step
stops only on its own errors, the starter set billing takes once priced, Next
held on the cap, the starter drawn, the review's cost and day, one save.
