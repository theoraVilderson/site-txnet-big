---
id: panel-web
layer: interface
status: active
version: 16
updated: 2026-09-12
---

# Contract — panel-web: the dashboard shell (F-093-a)

Split from [contract.md](contract.md) at 250 lines (§10). The frame every page
under `(panel)` renders in: `_components/PanelShell.tsx` = `PanelSidebar` +
`PanelTopBar` + the page. Mounted once, in `(panel)/layout.tsx`, inside
`PanelSessionProvider` and `PanelRealtimeProvider`. A page never renders its own.

## Rules a page row has to know

1. **The menu is `_lib/panel-menu.ts`, and it already lists every legacy
   entry.** A row that builds a page gives that entry an `href` (a route
   constant from `src/lib/routes.ts`); it does not add a second entry.
2. **An entry with no page is hidden, never a dead link.** `href: null` hides
   it; a group with no visible child is hidden with it. `panel-menu.test.ts`
   reads the route tree and fails when an `href` has no `page.tsx` under
   `(panel)`. A page in a nested route group needs that test widened, not
   skipped. **An entry the caller may not use is hidden the same way** (F-097):
   `requires: [...]` lists permission keys, all needed, compared against
   `usePanelSession().me.permissions` (`GET /auth/me`). No `me` hides every
   gated entry. An operator-only page also checks `me.tenant.type` — the key
   alone is not the boundary. An entry only one kind of tenant has names
   `tenantTypes` (F-019-d: `tenant-billing`, reseller only); `*` does not stand
   in for it, and no `me` hides it. `ownerSuffices` lets `me.tenant.isOwner` stand in for
   `requires`, never for `tenantTypes` (F-019-f: `tenant-billing`). Never a role word in a route (D-28, F-098).
3. **One entry is highlighted:** the longest href that is the path or a
   whole-segment prefix of it (`activeHref`). A detail page under
   `/financial/…` lights its parent without a second rule.
4. **Sides are logical.** `start`/`end`, `ms`/`me`, `border-s`/`border-e` —
   never `left`/`right`, because the same build runs RTL and LTR. The one
   physical transform (the drawer's slide) is written for both scripts.
5. **The top bar has no profile menu.** Account actions live in
   `AccountSwitcher` (F-0209). A new top-bar control (wallet F-093-c,
   notifications F-093-h) goes before the switcher and must fit a 360px bar:
   below `sm`, language and theme already moved into the drawer to make room.
   **The budget is the row, not the control**, and it is the rule that is
   easiest to break by adding something reasonable. Measured at 360px: the bar
   has **304px** of content box, and once the wallet joined the row it wanted
   **~337px**. The overflow lands on whichever control is last, so the control
   that looks broken is rarely the one at fault. Three consequences, each of
   them learned the expensive way on `LogoutButton`:
   - **Shrinking the last control does not fix a row that is over budget.**
     Collapsing its label returns ~34px against a 33px overflow, so the next
     digit in a balance spills it again.
   - **A `sm:` escape hatch is not a fix either.** Moving it to the drawer only
     below `sm` left the bar broken across the whole tablet band, because at
     `sm` the language and theme controls come *back* while the menu button is
     still there: **640–1023px is the widest the row ever gets**, not the
     narrowest. Measured at 700px, 620px of content box against ~643px of row
     even after logout had left. **A control the drawer holds is held for as
     long as the drawer exists, which is below `lg`** — the breakpoint that
     decides drawer-or-rail is the one these follow, and `sm` never was.
     Below `lg` the bar is now the menu button, the wallet and the switcher,
     ~430px.
   - **The header cannot clip the spill.** The wallet and switcher dropdowns are
     absolutely positioned children of it, so `overflow-hidden` there cuts the
     open menus and leaves the overflow.

   So a control that does not fit does not belong in the bar. Logout is now a
   **nav** entry (below), which is where ADR-0035 always said it lived.

6. **Logout is a nav action, not a top-bar control.** It renders in the
   sidebar footer at every width, shaped like a menu entry — same padding and
   icon size, `lg:sr-only` label with a `CollapsedTooltip` on the collapsed
   rail. The placement is not a layout preference: `AccountSwitcher`'s menu
   ends with *sign out of all devices*, behind its own confirmation, and the
   everyday logout is deliberately kept away from it, because the two are
   different intentions and the destructive one must not be a mis-tap from the
   ordinary one. Putting logout in that menu would undo the separation; putting
   it in the bar was what broke the bar.

   What remains below `lg` — the menu button, the wallet, the switcher — is
   ~286px at 360px and ~430px at 700px, and fits both. **The wallet's figure is the one unbounded term left**:
   it has no truncation, so a long enough balance puts the row back over
   budget. Bounding it means accepting a truncated balance, which the wallet
   control's rule 1 has an opinion about, so it is a decision and not a
   tidy-up.

## The wallet control (F-093-c)

`_components/WalletButton.tsx` + `_hooks/useWalletBalance.ts`. The first thing
in this app to call a backend other than `auth-service`, so two of its rules are
about the data path rather than the bar.

1. **The panel never computes a balance.** It shows the decimal string
   `billing` last answered and re-reads on a wallet event; it never adjusts a
   held figure by an event's amount. `wallet.cachedBalance` is written only
   inside the transaction that appends the proving ledger row
   ([billing/contract.history.md](../../domains/billing/contract.history.md)),
   so re-reading is the only thing that can be right. Legacy kept the balance in
   a client store and let components add to it — a refused gift code showed
   success over a balance of `NaN` (F-093-g).
2. **The event's payload is not read**, only its arrival. There is no agreed
   shape for a payment event yet — `F-092-j` is the row that will publish one —
   and a hook that parsed an amount would have to guess that shape and break
   quietly when the guess was wrong. Any message on `user:<userId>` is a reason
   to ask again. The channel name comes from `lib/realtime.ts`'s `userChannel()`,
   not spelled at the subscriber: the gateway decides access by matching the
   string, and a second spelling is refused with no status a browser can see.
3. **The balance is read from `wallet/history` with the smallest page**, because
   `{balance}` is already that route's first field. A `GET /wallet/balance`
   would be a second endpoint answering a value the first one has.
4. **The quick actions follow rule 2 above** — an entry with no destination is
   hidden rather than rendered as a dead link. A destination is an `href` *or* a
   `modal`: `history` points at `PANEL_FINANCIAL` since F-093-d, `gift-code`
   opens the modal below since F-093-g, and `top-up` points at `PANEL_DEPOSIT`
   since F-093-e ([contract.deposit.md](contract.deposit.md)) — so every entry
   has a destination now, and the filter stays because it is how the next one
   is added. A `modal` entry renders as a `button`, never a `Link`
   with a dead href — a link that navigates nowhere is still announced as a link
   and offered to "open in a new tab". Legacy's fourth entry (`/services`) is
   not ported: it duplicated the sidebar's `my-services`.
5. **A failed read is not a zero.** `"0.00"` is a real balance — a user with no
   wallet reads as zero, not a 404 — so a failure shows its own line and a
   retry, and keeps the last good figure rather than blanking it.

`lib/billing-api.ts` is the client, and `lib/api-request.ts` is the envelope
both it and `auth-api` read. See [contract.md](contract.md) "Client API surface"
for why the browser calls `api.<domain>` directly rather than through a proxy.

## The gift-code modal (F-093-g)

`_components/GiftCodeModal.tsx`, opened by the wallet's `gift-code` quick
action. A code box is not worth a route — there is nothing to link to, bookmark
or come back to — so this is the first overlay the dropdown opens rather than
navigates to, and rule 4 above is how a second one is added.

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
7. **A free-service code shows its key once** (F-502-l-c, D-35): a `free_grant`
   answer shows the service and its `subscriptionKey` with a copy button and
   "shown only this once" — billing keeps only the hash. No money figure, no burst.

## State

`_stores/panel-ui-store.ts` — collapsed (desktop), drawer open (below `lg`),
the one open submenu. UI only, in memory, reset by a reload. A modal that must
cover the sidebar (F-093-g) needs a z-index above the sidebar's `z-40` and its
`z-30` backdrop; `GiftCodeModal` is `z-50` for that reason.
