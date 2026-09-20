---
id: panel-web
layer: interface
status: active
version: 27
updated: 2026-09-20
---

# Contract — panel-web: the gift-code modal (F-093-g)

`_components/GiftCodeModal.tsx`, opened by the wallet's `gift-code` quick
action. Its own file rather than a section of
[contract.shell.md](contract.shell.md), which is at §10's 250-line ceiling —
the split is F-502-m's, and no rule below changed with it except where one says
so. A code box is not worth a route — there is nothing to link to, bookmark or
come back to — so this is the first overlay the shell's dropdown opens rather
than navigates to, and rule 4 of [contract.shell.md](contract.shell.md) is how
a second one is added.

The refusal sentences are `billing`'s, already translated
([billing/contract.gift.md](../../domains/billing/contract.gift.md)); the
balance behind it is the wallet control's
([contract.shell.md](contract.shell.md), "The wallet control").

1. **A refusal ends the submit.** `billing` answers every unredeemable code with
   a 409 and a sentence it has already translated
   ([billing/contract.gift.md](../../domains/billing/contract.gift.md)), so the
   client throws and there is no success path to fall into. This is the bug the
   port exists to leave behind: legacy's `DiscountModal.tsx` set its error on a
   `nok` answer and then ran the success branch anyway, because the branch had
   no `return`.
2. **Nothing here touches the balance.** A redemption tells the wallet control
   to re-read, and is never handed an amount to add — rule 1 of the wallet
   control above, which is the other half of the same legacy bug: every answer
   did `walletBalance + data.amount`, and on a refusal `amount` is undefined, so
   a dead code showed "gift activated" over a balance of `NaN`. The `credited`
   and `balance` the success panel shows are billing's own answer to that one
   call, formatted — not a sum worked out here.
3. **The five refusals stay on the server side of the wire.** Each already names
   where the code does belong ("this is a discount code, enter it when you top
   up"), so this app keeps no copy of any of them and branches on no reason
   code. It follows [contract.errors.md](contract.errors.md): the sentence goes
   on screen as it arrived, `role="alert"`, cleared per attempt, with the `ref`
   shown so a user can quote it.
4. **The success panel waits to be closed.** Legacy dismissed itself on a timer
   whose callback read a stale `status` to decide whether to — and the user has
   just been shown a number they may want to read twice.
5. **The motion is on the frame, never on the money.** This is the most animated
   surface in the panel on purpose — redeeming a gift is the one moment here
   that is pure good news, and the rest of the app is deliberately flat. The
   card springs, the check draws itself, a burst fires, a refusal shakes the
   body of the card. **No figure is ever animated from one value to another**: a
   number counting up is a number that is briefly wrong, which is the same habit
   rules 1 and 2 exist to break. Everything collapses to a plain cross-fade
   under `prefers-reduced-motion` — in CSS where the animation is CSS, and via
   `useReducedMotion` where it is not — and every decorative element (the two
   orbs, the sparks, the focus underline, the button sweep) is `aria-hidden`
   and inert.
6. **CSS animates, framer-motion only where CSS cannot.** framer-motion earns
   its place for an *exit* animation, an `auto` height, or an imperative shake;
   a one-shot entrance and an infinite decorative pulse have none of those, and
   belong in `globals.css` (`.gift-rise`, `.gift-pop`, `.gift-orb`). This is
   measured, not taste. The code box is controlled, so **every keystroke
   re-renders the dialog and each motion component in it pays for that
   re-render**. Six of them took this unit's slowest spec from 2.0s to **4.2s
   against vitest's 5s ceiling**, and it then failed 4 of 6 full-suite runs
   while passing alone — a timeout, which reads exactly like a broken assertion
   and is not one. Moving the six to CSS gave back 2.3s of it; filling the code
   box with one change event instead of eight simulated keystrokes gave back the
   rest, and the spec now runs at **1.7s**. The residue was contention from the
   other 19 spec files, so the file also takes `testTimeout: 15s` — headroom for
   the machine, after the code was made cheap and not instead of it. Five
   consecutive full runs are clean, where 4 of 6 had been failing. A new
   animation here starts in CSS and moves only if it turns out to need one of
   the three.

   The cost needs a controlled input to bite, so the success panel keeps
   framer-motion: it mounts once, on an answer, and what it animates — a stroke
   drawing along its own path, eight sparks whose end point is computed per
   angle — is what the library is actually for.

   The wider rule, for any panel screen: **a spec that drives a controlled input
   through an animated tree pays per character.** Type only where the typing is
   what the case is about.
7. **It locks the page behind it and gives the scroll back on unmount.** The
   lock lifts when the dialog leaves, not when the prop flips, because the
   dialog animates out; a page left unscrollable is the failure that matters.
8. **The overlay scrolls; the card is not centred in a frame that cannot.**
   `fixed inset-0 overflow-y-auto` holding a `flex min-h-full items-center`
   wrapper, with the backdrop `fixed` so it does not scroll away. A centred card
   in a frame with no scroll is clipped at **both** ends the moment it outgrows
   the viewport, and the end that goes is the one with the title on it. An error
   message is enough to trigger that — it grows the card by the height of a
   sentence — which is exactly how it was found in `fa`.

9. **It is portaled to `document.body`, and that is load-bearing.** Its caller
   is `WalletButton`, in a top bar carrying `backdrop-blur-xl` — and **an
   element with a `backdrop-filter` is the containing block for every
   fixed-position descendant.** So `fixed inset-0` rendered in place did not
   mean the viewport, it meant that 64px rounded bar, and the modal opened
   invisible, looking exactly like an `overflow: hidden` on the nav. The bar's
   `z-20` caps the stacking order the same way, so rule 8's `z-50` could never
   clear the sidebar's `z-40` from in there either. **Any overlay this shell
   grows next — the notifications panel of F-093-h included — has the same two
   problems and wants the same portal**, because this bar and the sidebar both
   carry `backdrop-blur-xl`. jsdom models neither the containing block nor the
   stacking context, so the spec holds the part it can: the dialog is a child of
   `body` and not of whatever mounted it.

**The RTL trap this screen fell into, for anyone adding to it:** rule 4 above
says sides are logical, and the failure mode is not forgetting it but *mixing*
it. `start-1/2` with `-translate-x-1/2` centres a thing in LTR and throws it off
the left edge in RTL, because the first half is direction-aware and the second
half is not. Either stay physical on both (`left-1/2` with `-translate-x-1/2`,
fine when the thing is symmetric, which is what the success burst does) or use
`ltr:`/`rtl:` variants the way the drawer's slide does. The focus underline
under the code box was the mixed kind and is gone: the border turning `primary`
with its glow already says where focus is, and a straight line under a
`rounded-2xl` border was never the tidier answer.

The modal is mounted outside the dropdown's own `open &&`, so closing the
dropdown does not unmount a code the user is half-way through typing, and the
dropdown suspends its own Escape and outside-press handlers while the modal is
up. One key closing both would leave the user with neither.

`AnimatePresence` is what stays mounted; the dialog is not, so **mounting is the
reset** — a closed modal holds no half-typed code and no previous attempt's
error, with no effect that has to remember to clear each one. Resetting in an
effect is also what `react-hooks/set-state-in-effect` refuses.
10. **A free-service code shows its key once** (F-502-l-c, D-35): a `free_grant`
    answer shows the service and its `subscriptionKey` with a copy button and
    "shown only this once" — billing keeps only the hash. No money figure, no
    burst. (It was written as a second "7." when F-502-l-c added it; the number
    is corrected here, not the rule.)
11. **While that key is on screen, the accidental dismissals ask instead of
    closing** (F-502-m, relaxed by F-502-q). Billing stores the hash alone, so
    an unmeant dismissal is a key the user never copied. `Escape` and a backdrop
    click are the two ways to close a dialog *without deciding to*, and for
    `kind === "free_grant"` neither closes it: both raise the question in the
    card — "the key is shown only once; if you have not copied it, ask for a new
    one first" — over "go back" and "close anyway". The X and "done" are aimed
    at and still close on the first press. Until F-502-q the two were simply
    inert, because there was no second answer to offer; now there is one, and a
    dialog that swallows `Escape` outright is no longer the smaller loss.
12. **A key that did not reach the user is asked for again, not mourned**
    (F-502-q, over `billing`'s `POST /gift/grants/:id/rotate-token`). The
    clipboard write throws on an insecure origin, a selection is half a key, a
    paste lands in the wrong window — so the key panel carries a second button
    that mints a new one. Its rules follow from the route
    ([billing/contract.gift.md](../../domains/billing/contract.gift.md)) and
    from rule 10, which the new key obeys exactly as the first did:
    - **The Grant's id is the whole request.** The route takes no body and the
      owner is the gate's user, so this app sends no user and branches on no
      reason code — another user's Grant and a missing one are one 404.
    - **What comes back replaces what is on screen.** The old key is dead
      inside billing's transaction, so leaving it up to be copied would hand
      the user a credential that opens nothing. The "shown only this once" line
      stays, joined by one saying the previous key has stopped working.
    - **A refusal changes nothing.** Nothing was minted, so the key already
      shown is still the key; billing's own sentence goes on screen,
      `role="alert"`, with its `ref` ([contract.errors.md](contract.errors.md)).
      The bucket is 5 per 900s and each call destroys a working key, so the
      button is disabled while its ask is in flight and never retries for the
      user.

**Not covered:** a key lost after the modal is closed. This panel has no list of
a user's Grants, so the button is reachable only while the key is up; a Grant
whose key was lost yesterday still has no way back, and giving it one is a
surface of its own, not a rule here.
