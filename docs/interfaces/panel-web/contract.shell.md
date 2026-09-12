---
id: panel-web
layer: interface
status: active
version: 14
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
   skipped.
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
4. **The quick actions follow rule 2 above** — `href: null` hides the entry
   rather than rendering a dead link. `history` points at `PANEL_FINANCIAL`
   since F-093-d; top-up and gift code stay hidden until F-093-e and F-093-g,
   and the dropdown says so. Legacy's fourth entry (`/services`) is not ported:
   it duplicated the sidebar's `my-services`.
5. **A failed read is not a zero.** `"0.00"` is a real balance — a user with no
   wallet reads as zero, not a 404 — so a failure shows its own line and a
   retry, and keeps the last good figure rather than blanking it.

`lib/billing-api.ts` is the client, and `lib/api-request.ts` is the envelope
both it and `auth-api` read. See [contract.md](contract.md) "Client API surface"
for why the browser calls `api.<domain>` directly rather than through a proxy.

## State

`_stores/panel-ui-store.ts` — collapsed (desktop), drawer open (below `lg`),
the one open submenu. UI only, in memory, reset by a reload. A modal that must
cover the sidebar (F-093-g) needs a z-index above the sidebar's `z-40`.
