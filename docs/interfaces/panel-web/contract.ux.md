---
id: panel-web
layer: interface
status: active
version: 42
updated: 2026-10-05
---

# panel-web — the panel's design system, motion and navigation (UX-1)

**Target, not yet code.** Every rule below was decided with the user on
2026-10-05 and cites the `UX-1-*` row that builds it. While that row is `todo`
the rule describes what the row must build; the row's session makes it true and
adds its proof. Nothing here is a question left open — a builder who finds one
raises it, it is not decided in passing.

Audit that produced it (2026-10-05, `site-pwa/src/app/(panel)`, ~45k lines):
578 hand-rolled `<button>`, 196 `<input>`, 24 local input-class constants, 4
divergent `primaryButton` strings, 14 hand-built overlays, 14 hand-built tab
bars, 26 `window.confirm`, motion in 9 of ~250 files, no `template` / `loading`
/ `error` / `not-found`, 11 `<table>` files with no phone layout, 15 uses of an
undefined `success` colour, 82 `text-white` on `bg-primary`.

## Kit — one set of primitives (`_components/kit/`)

| # | Rule | Row |
|---|---|---|
| K1 | Semantic tokens `success`, `warning`, `info` (each with `-bg`, `-border`) and `on-accent`, `on-error` exist in all three themes and in `@theme`. A primary surface carries `text-on-accent`, never `text-white` — the dark theme's accent is light green and white on it fails contrast. A tenant's brand colour sets `--text-on-accent` with the accent (`contract.branding.md`). Built: `globals.css`, proof `src/app/theme-tokens.test.ts` | UX-1-a |
| K2 | One focus ring: `focus-visible` 2px `primary` outline, 2px offset, on every interactive primitive; today a base-layer `:focus-visible` rule in `globals.css`, which a control's own focus utility still overrides | UX-1-a |
| K3 | `Button`: variants `primary` / `secondary` / `quiet` / `danger`; sizes `sm` h-8 text-xs, `md` h-10 text-sm, `lg` h-12 text-base; `rounded-xl` (`lg`: `rounded-2xl`). `loading` swaps the icon for a spinner, keeps the label and width, sets `disabled` and `aria-busy`. Press scales to 0.97. `IconButton` is the same with an `aria-label` it requires. Built: `kit/Button.tsx`, proof `kit/kit.test.tsx` | UX-1-c |
| K4 | `Field` wraps `Input` / `Textarea` / `Select` / `PasswordInput`: label above, hint below; an error replaces the hint, in `error` with an icon, wired by `aria-describedby` and `aria-invalid`. `maxLength` shows a counter. Inputs are h-11, `rounded-xl`. Built: `kit/Field.tsx`; the kit `Select` reads the Field through `kit/field-context.ts` | UX-1-c |
| K5 | `Toggle` (moved out of `gateways/_components/gateway-fields.tsx`), `Checkbox`, `RadioCards`, `SegmentedControl` with a sliding indicator (`layoutId`); both choice controls are radio groups with arrow keys. Built: `kit/Toggle.tsx`, `kit/choice.tsx` | UX-1-c |
| K6 | `Card`, `Badge` / `StatusPill` (tones `neutral`, `success`, `warning`, `error`, `info`, `gold`), `EmptyState` (icon, title, one sentence, optional action), `Alert` (tone + optional action), `AnimatedNumber` (count-up 600ms on first paint only; text is the final value for screen readers). Built: one file each in `kit/`, all exported from `kit/index.ts` | UX-1-c |
| K7 | Overlays: `Dialog`, `Sheet` (from the end side ≥`md`; a bottom sheet below `md` that drags down to close), `Menu`, `Popover`, `Tooltip`. Every one traps focus, locks body scroll, closes on Esc and backdrop, returns focus to its trigger, animates in and out through `AnimatePresence`. Esc closes only the topmost (`kit/overlay.ts` keeps the stack and counts the scroll locks). A `Menu` closes on Tab instead of trapping it (WAI-ARIA menu button); a `Tooltip` holds no focus, so it neither traps nor locks. Menus, popovers and the kit `Select` sit at `z-[60]`, above dialogs at `z-50`. Built: `kit/{Dialog,Sheet,Menu,Popover,Tooltip}.tsx`, proof `kit/overlays.test.tsx` | UX-1-d |
| K8 | `Tabs`: an indicator that slides (`layoutId`); arrow keys move between tabs; optional `?tab=` sync with the URL (`urlParam`; a value naming no tab reads as the first). Built: `kit/Tabs.tsx` | UX-1-d |
| K9 | `useConfirm()` returns a promise of a boolean; `{title, body, confirmLabel, tone: 'default' \| 'danger', typeToConfirm?}`. Type-to-confirm (the user types the object's name) only for: deleting a gateway, deleting categories that hold products, retiring two or more configs, unlisting a package's product, emergency support access. A dirty-close question uses `default`. Built: `kit/confirm.tsx`, `ConfirmProvider` at `(panel)/layout.tsx`; focus starts on Cancel for `danger`, on the name box for type-to-confirm | UX-1-d, UX-1-y |
| K10 | Toasts are `react-hot-toast` behind `notify.success / error / info / promise`, themed with the tokens; bottom-centre below `md`, bottom-end above; success and info 4s, error 6s; at most 3 on screen; errors `assertive`, the rest `polite`. A form's own error stays inline (K4); a toast is for an action with no form — delete, copy, toggle, a save that succeeded. The library's own limit is a fixed 20, so `PanelToaster` dismisses past the third. Built: `kit/notify.tsx`, `PanelToaster` at `(panel)/layout.tsx`; nothing else imports `react-hot-toast` | UX-1-e |
| K11 | `SaveBar` + `useUnsavedGuard`: a dirty form shows a bar that slides up — "unsaved changes", Save (loading per K3), Discard. Leaving a dirty page asks (K9, `default`), in-app links and `beforeunload` alike. "Saved" is a toast, never a line of text that stays; a rejected save adds no toast (the form's error is inline) and the bar stays. Links are caught at the document in the capture phase; a `router.push` from code asks with `confirmLeave()` first. Built: `kit/SaveBar.tsx`, `kit/useUnsavedGuard.ts`, proof `kit/feedback.test.tsx` | UX-1-e |
| K12 | `Wizard`: a step rail at the start side ≥`lg`, a progress bar below it, directional slide between steps, per-step validation before Next, a review step, closing a touched wizard asks (K9). It is extracted from `GatewayWizard`, and `GatewayWizard`, `systems/RegisterWizard`, `catalog/ProductWizard` move onto it with behaviour unchanged. The host keeps its form; `useWizard` keeps the step, the furthest step reached and the direction, and runs the host's `validate` on Next. Esc, the X, the backdrop and Cancel are one close. Built: `kit/Wizard.tsx`, proof `kit/wizard.test.tsx` | UX-1-f |
| K13 | `DataTable`: a table from `md` up; below `md` each row is a card — the first column as its title, up to four more as label : value, row actions in a `Menu`. Sortable headers where the page already sorts; selection shows a sticky bulk-action bar. Both layouts are drawn and CSS shows one, so the first paint is right; a column without a header, or marked `hideOnCard`, stays off the card. Built: `kit/DataTable.tsx`, proof `kit/data-table.test.tsx`; every panel table is on it, and `kit/tables.test.ts` fails on a `<table>` written anywhere else under `(panel)/` | UX-1-g, UX-1-h |
| K14 | `PageHeader`: title, one-line subtitle, actions at the end, breadcrumbs above the title from `md` up (a back link to the parent below it). The trail is the menu tree — section › group › page — plus the page's own tail label. Today the tree is group › page; sections join it with UX-1-j. A tenant-scoped entry matches whatever tenant the path names, so the trail needs no session. Built: `kit/PageHeader.tsx`, `menuTrail` in `_lib/panel-menu.ts`, proof `(panel)/frame.test.tsx`. The reseller workspace, the dashboard and settings move onto it with UX-1-ad, UX-1-p and UX-1-s | UX-1-i |

## Motion

| # | Rule | Row |
|---|---|---|
| M1 | Tokens in `src/lib/motion.ts`: `fast` 120ms (hover, press), `base` 200ms (fades, tabs), `slow` 320ms (sheets, dialogs); easing `standard` cubic-bezier(0.2,0.8,0.2,1), `exit` cubic-bezier(0.4,0,1,1); sheet spring stiffness 380, damping 34. Presets `fadeRise` (opacity + 8px), `stagger` (40ms, the first 8 children only — `staggerDelay`), `pop`; each takes the level. Built: proof `src/lib/motion.test.tsx` | UX-1-b |
| M2 | Two levels, `full` and `reduced`. The user's `ui.motion` decides when it is `full` or `reduced`; at `system` the OS `prefers-reduced-motion` decides; failing both, inside the Mini App on a weak device (`hardwareConcurrency <= 4` or `deviceMemory <= 2`) it is `reduced`; a device that reports neither is not weak. `resolveMotionLevel` decides; `useMotionLevel` is it live, `system` until UX-1-l | UX-1-b, UX-1-l |
| M3 | `reduced` = opacity only, at most 120ms; no translate, scale, stagger, layout animation, count-up or confetti. One switch: `<MotionConfig>` at the panel layout and `data-motion="reduced"` on `<html>`, which also stops every CSS keyframe in `globals.css` (gift, pay) and drives Tailwind's `motion-reduce:` / `motion-safe:`. `MOTION_SCRIPT` sets it before the first paint; nothing reads `prefers-reduced-motion` but the level, and framer's reads are `useReducedMotionConfig` | UX-1-b |
| M4 | Pages enter with `fadeRise` at `base` from `(panel)/template.tsx`; there is no exit animation, so navigation never waits. A thin progress bar runs at the top while a route loads: it starts on a click on an internal link nobody else handled and ends when the path or query changes. Built: `(panel)/template.tsx`, `_components/RouteProgress.tsx` | UX-1-i |
| M5 | Celebrations, once per occasion per view: a payment credited (`/payment/success`), a gift code redeemed, a wheel prize that is not empty, a shop purchase delivered. A canvas confetti of our own in the kit (≤120 particles, 1.6s, no new dependency) | UX-1-z |
| M6 | Haptics only where `window.Telegram?.WebApp?.HapticFeedback` exists, else nothing: `impactOccurred('light')` on a primary `Button`, `notificationOccurred('success' \| 'error')` with a celebration and with `notify.error` | UX-1-z |

## Shell and navigation

| # | Rule | Row |
|---|---|---|
| N1 | The menu is sectioned. `account` — dashboard, shop, my services, wallet (financial history, top-up), wheel, lotteries, support, buy a reseller. `sales` — catalog, coupons, AI, wheel settings, lottery settings. `finance` — gateways, manual payments, reseller billing. `people` — users, user groups, resellers (list, packages, limits). `infra` — systems. `support` — support inbox, support settings, guides. Settings sits in the footer above logout | UX-1-j |
| N2 | A section with nothing visible is not drawn; a caller who sees only `account` sees no headings at all. Sections fold, animated by height; which are folded is `ui.sidebar.closedSections` | UX-1-j, UX-1-m |
| N3 | The active entry's highlight slides between entries (`layoutId`); a group's children animate open. Collapsed (≥`lg`), a group opens a flyout `Popover` at its side instead of re-expanding the sidebar; below `lg` the drawer closes by swipe toward its edge as well as by backdrop and Esc | UX-1-j |
| N4 | Badges: support — the unread total over the first page of the user's threads; support inbox — the `unassigned` view's first page; manual payments — the open list's first page. Shown 1–9, then `9+`. Refreshed on mount, on the realtime events that channel already has, else every 60s while the tab is visible | UX-1-j |
| N5 | Pins: up to 8 menu entries in a "pinned" block at the top, pinned or unpinned from the entry's own menu or the palette, reordered by drag and by up/down buttons; stored in `ui.pins`. Recent pages are this device's last 10 (`localStorage`), never the server — history, not a preference | UX-1-m |
| N6 | The palette opens on Ctrl/⌘+K and from a search button in the top bar (an icon below `sm`). It finds pages (the caller's visible menu, so never one they may not open), settings tabs (`/settings?tab=`), actions (top up, new ticket, gift code, theme, language, motion level) and recent pages. Matching ignores case, folds Arabic ي/ك into Persian ی/ک and Persian/Arabic digits into Latin, and searches every entry's labels in the current language and English. Arrow keys, Enter, Esc | UX-1-n |
| N7 | Data in the palette, each group loading on its own after 300ms of no typing and at least 2 characters: services by name or a pasted config link (the My services search); the caller's tickets (`q`, UX-1-v); users by phone, username or email — the platform's `GET /auth/users?q=` for `user.search`, a reseller's own `GET /auth/tenants/:id/users?q=` for `tenant.manage`. A group that answers 403 hides itself for the session | UX-1-o |
| N8 | The reseller workspace (`/my-resellers/:id/…`) has a tab bar under its `PageHeader` on every one of its pages: overview, users, catalog, domains, gateways, bot, branding — links, active by path | UX-1-ad |
| N9 | `(panel)/loading.tsx` is the shell's skeleton; `error.tsx` is a card with "try again" (reset), "back to the dashboard", and the error digest with a copy button for support; `not-found.tsx` offers the palette and the dashboard; `(panel)/[...missing]` sends every unknown panel path there, inside the shell, with status 200: under `loading.tsx` the page is already streaming when `notFound()` runs. The palette button arrives with the palette | UX-1-i, UX-1-n |

## Preferences — governance `user_setting`, category `display`

| # | Rule | Row |
|---|---|---|
| P1 | They live in governance's existing `user_setting` table (`(userId, key)` unique, JSON value), never in a new column: it is already the home of a person's settings and already has a `display` category. Built: `governance/ui-preferences/`, proof `ui-preferences.spec.ts` | UX-1-k |
| P2 | Keys: `ui.motion` `'system' \| 'full' \| 'reduced'` (default `system`); `ui.dashboard` `{order: string[], hidden: string[]}` (≤30 ids each, an id ≤40 chars); `ui.pins` string[] ≤8; `ui.sidebar` `{collapsed: boolean, closedSections: string[]}`. A value over 4 KB is refused | UX-1-k |
| P3 | `GET /api/auth/me/ui-preferences` answers every key, defaults filled in. `PATCH` takes any subset, validated strictly; an unknown key is 400 `unknown_preference`. Only the caller's own row is ever read or written | UX-1-k |
| P4 | The panel loads them once after `/auth/me`, applies them at once, and writes optimistically with a 600ms debounce; a failed write rolls back and says so with `notify.error` | UX-1-l |

## Dashboard (`/`)

| # | Rule | Row |
|---|---|---|
| D1 | A registry, `(panel)/_lib/widgets.ts`: `{id, titleKey, size: 1 \| 2, requires?, tenantTypes?}` — the same gating as the menu (`PermissionGated`) — and a lazily loaded component. A grid of 1 column below `md`, 2 from `md`, 3 from `xl`. Each widget has its own skeleton, empty and error state, and enters with `stagger` | UX-1-p |
| D2 | A header greets the user by name and time of day (in their resolved zone) with the account they are in. "Accounts in this browser" stays, as a widget (F-0209: a switch must be visible) | UX-1-p |
| D3 | "Edit layout" shows each widget with a hide toggle, a drag handle and up/down buttons, and "back to default"; Done writes `ui.dashboard`. An id no longer in the registry is ignored; a new widget absent from the saved order takes its default place | UX-1-p |
| D4 | User widgets: `quick-actions` (top up, gift code, buy, new ticket); `wallet` (balance with `AnimatedNumber`, held apart, top up and gift code); `services` (size 2: active services with their usage meter, "running out" per U3, buy); `support` (open threads, unread first); `notifications` (the latest 5); `wheel` (whether a spin is open today); `accounts` | UX-1-q |
| D5 | Staff widgets, each by the permission of the page it links to: `revenue` (size 2; today, 7 and 30 days from `GET /billing/tenants/:tenantId/revenue`), `manual-payments` (`payment.confirm_manual`), `support-queue` (`support.agent`: unassigned, mine, waiting), `users` (`tenant.manage`: the total and a search that opens the users page), `systems` (`panel.manage`, platform only: panels by verdict). A widget whose source answers 403 hides itself for the session | UX-1-r |
| D6 | Default order: quick-actions, wallet, services, the staff widgets, support, notifications, wheel, accounts | UX-1-p |

## Settings (`/settings`)

| # | Rule | Row |
|---|---|---|
| S1 | Tabs, `?tab=`: `profile` (name, email, password, active sessions), `notifications` (notices, messenger), `appearance` (theme, language, time zone, motion level), `workspace` — "platform settings" for the platform owner, "reseller settings" for a reseller (operating currency, tenant time zone, manual rates), drawn only when one of its cards is allowed. Default `profile` | UX-1-s |
| S2 | ≥`lg`: a 240px nav at the start side and content up to `max-w-3xl`; below `lg`: scrolling pill tabs (K8). Every form on it uses K4 and K11 | UX-1-s |
| S3 | Name: shown with an edit button that turns into a field in place; `PUT /api/auth/me/name` `{fullName}`, trimmed, the register form's rules | UX-1-t, UX-1-u |
| S4 | Password: current, new (with a strength meter), repeat, and "sign out every other place", ticked by default; `POST /api/auth/me/password` `{currentPassword, newPassword, endOtherSessions}`. The register form's password rules; a wrong current password is 400 `wrong_password`; 5 tries per 15 minutes per user; the other places are ended through SES-1-a's service | UX-1-t, UX-1-u |

## Tickets (`/support`)

| # | Rule | Row |
|---|---|---|
| T1 | `GET /api/support/conversations` takes `status` (comma-separated `ConversationStatus`) and `q` (2–64 characters, matched on the subject and the non-internal message bodies of the caller's own threads); `GET /api/support/conversations/counts` answers a count per status | UX-1-v |
| T2 | The list: tabs All, Open (`open` + `pending_agent`), Waiting for you (`pending_user`), Resolved, Closed, each with its count; a search box (300ms); both in the URL (`?status=&q=`). A row shows the status pill, an unread dot, the last message's first line and a relative time | UX-1-w |
| T3 | A new ticket is a `Sheet` holding a `Wizard`: 1. category as cards (skipped when there are none); 2. subject, message, files (drag and drop, image thumbnails); 3. the guides that may answer it, with "send the ticket" and "this solved it" (closes, nothing sent). Files are attached after the thread opens; if that fails, the thread opens with an `Alert` to attach them again | UX-1-w |
| T4 | A thread (user's and agent's): messages enter with `fadeRise`; day separators in the resolved zone; one sender's messages within 5 minutes grouped under one label; typing as three animated dots; images as 160px thumbnails opening in a `Dialog`; paste and drag-drop add files; the composer grows with its text; Ctrl/⌘+Enter sends and plain Enter inserts a line, on desktop and touch alike (user, 2026-10-05) — the send button is the other way, and its tooltip names the shortcut; away from the bottom by >200px a button returns there with the count of messages that arrived; the rating is five animated stars | UX-1-x |

## User journeys

| # | Rule | Row |
|---|---|---|
| U1 | The shop shows three steps — choose, invoice and pay, delivered — mapped from its `phase`, and slides between them; an offer card lifts on hover and marks the chosen one | UX-1-aa |
| U2 | My services: the usage meter animates to its value; each row's actions are one `Menu` | UX-1-aa |
| U3 | "Running out": a service ending within 3 days or with 10% or less of its quota left carries a `gold` `StatusPill` (gold is allowed on status, never on a control). The list's order does not change | UX-1-aa |

## Enforced

| # | Rule | Row |
|---|---|---|
| E1 | Under `site-pwa/src/app/(panel)/`, outside `_components/kit/`, `tools/conventions.py` fails on `window.confirm(`, on a local `primaryButton` / `quietButton` / `input` class constant, and on `text-white` beside `bg-primary`; a new `C-nn` names it. `@mui/material` and `@emotion/*` leave `site-pwa/package.json` when nothing imports them | UX-1-af |

Every new string is a key in every language under `locales/frontend`, referenced through the generated constants (C-06).
