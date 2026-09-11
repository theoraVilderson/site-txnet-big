---
id: panel-web
layer: interface
status: active
version: 12
updated: 2026-09-11
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

## State

`_stores/panel-ui-store.ts` — collapsed (desktop), drawer open (below `lg`),
the one open submenu. UI only, in memory, reset by a reload. A modal that must
cover the sidebar (F-093-g) needs a z-index above the sidebar's `z-40`.
