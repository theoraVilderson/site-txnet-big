---
id: panel-web
layer: interface
status: active
version: 26
updated: 2026-09-26
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
   A page inside the caller's own tenant has an `href` that is a function of
   `me.tenant.id` (F-311-ab: `users` -> `myResellerUsersPath`), hidden while
   that id is unknown; the route-tree test resolves it as `[id]`.
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

   What remained below `lg` — the menu button, the wallet, the switcher — was
   ~286px at 360px and ~430px at 700px. **F-093-h spent the rest of that**: a
   `p-2` bell is 40px with the gap, against 18px of slack. So the unbounded
   term left the bar instead of being truncated — below `sm` the wallet is its
   icon alone and the figure renders in that control's own dropdown header
   ([contract.notifications.md](contract.notifications.md)). ~220px at 360px.

## The wallet control (F-093-c)

`_components/WalletButton.tsx` + `_hooks/useWalletBalance.ts`. The first thing
in this app to call a backend other than `auth-service`, so two of its rules are
about the data path rather than the bar.

1. **The panel never computes a balance.** It shows the decimal string
   `billing` last answered and re-reads on a wallet event, and after a
   reconnect (`onMissed`, F-070-d) for one it may have missed; it never adjusts a
   held figure by an event's amount. `wallet.cachedBalance` is written only
   inside the transaction that appends the proving ledger row
   ([billing/contract.history.md](../../domains/billing/contract.history.md)),
   so re-reading is the only thing that can be right. Legacy kept the balance in
   a client store and let components add to it — a refused gift code showed
   success over a balance of `NaN` (F-093-g).
   Since F-111-m every movement is announced — `billing.wallet.changed` from
   the ledger itself, so a purchase, a gift code, an admin adjustment and a
   webhook top-up all reach the bar at once, not only a late credit.
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
and [contract.origin.md](contract.origin.md) for why the browser calls `/api` on
its own domain, routed by Traefik rather than a proxy in this app.

## The gift-code modal (F-093-g)

Moved to [contract.gift-code.md](contract.gift-code.md) when F-502-m needed a
rule this file had no room for. The quick action that opens it is rule 4 above;
the balance it makes re-read is the wallet control's rule 1.

## State

`_stores/panel-ui-store.ts` — collapsed (desktop), drawer open (below `lg`),
the one open submenu. UI only, in memory, reset by a reload. A modal that must
cover the sidebar (F-093-g) needs a z-index above the sidebar's `z-40` and its
`z-30` backdrop; `GiftCodeModal` is `z-50` for that reason.
