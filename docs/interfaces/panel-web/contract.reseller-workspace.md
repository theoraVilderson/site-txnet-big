---
id: panel-web
layer: interface
status: active
version: 1
updated: 2026-10-22
---

# Contract — panel-web: where a reseller's workspace lives (F-061-n)

A topic file of [contract.md](contract.md) (§10). The workspace itself — the
console and one screen per section — is ADR-0064 (4) and
[contract.resellers.md](contract.resellers.md). This file holds the two
addresses it has and how the one menu leads through it.

## Two addresses, one set of screens

| who | address | id from |
|---|---|---|
| the caller, for its **own** reseller — on its domain and on the platform's panel alike | `/reseller/…` | `useSelfResellerId` — rule 0 |
| platform staff, for any reseller; an owner, for a terminated one it still holds | `/my-resellers/:id/…` | the path |

0. **Whose own reseller comes from the door and the list, not `me.tenant`.**
   The owner is a user of the platform's tenant everywhere — on its
   reseller's domain too (ADR-0059: the handoff signs the same account in,
   branded by the door). On that domain `here` on `GET /auth/handoff` names it;
   on the platform's panel it is the owner's one `live` reseller
   (`already_reseller` allows no second). A staff seat signs in to the
   reseller's tenant, so for it `me` says it, with any reseller key
   (`selfResellerOf`, AC-1-e2). It sees the rows whose page's key it holds
   (`withResellerMenu`'s `seatHeld`); the home always. Read once per account and shared (`ownedResellersOf`),
   cleared after a purchase. The first build read `me.tenant` alone; the
   owner still saw `/my-resellers/<uuid>`, on its domain and then on the
   platform's panel (user, 2026-10-08).
1. **The caller's own reseller never shows `/my-resellers`.**
   `PlatformOnlyWorkspace` (the `[id]` layout) moves it to its `/reseller`
   twin — same section, same query — on either host. On a reseller's domain
   (`resellerDomainOf`: `me.tenant` there, or `here`) any other id is the
   panel's 404; on the platform's panel staff open other resellers by id.
   Nothing is drawn until both answer, so the id never flashes.
2. **`/reseller` is 404 for anyone with no reseller of their own** — platform
   staff who own none, a customer of the reseller — not a refusal that admits there is
   something behind it (`SelfWorkspace`).
3. **Every workspace link takes `self`.** The path builders in
   `lib/routes.ts` (`myReseller*Path(id, self)`, `resellerWorkspaceRoot`)
   build either address; a screen reads `self` from `useWorkspaceSelf(id)`.
   A menu `href` that is a function of the tenant gets `self` for a reseller's
   staff session (`visibleMenu`), and `menuTrail` places `/reseller/…` too.
4. **The screens are the same.** `/reseller/x/page.tsx` renders the view
   `/my-resellers/[id]/x/page.tsx` renders, handed that reseller's id.
   Admission is still tenant-service's and billing's (invariant 21); the
   panel only decides what it offers.

## One menu: the reseller's links in the account's sections (UX-2-a)

It replaced the sidebar's "my reseller" block and the workspace's tab bar
(`contract.ux.md` N8). User, 2026-10-08: account and reseller are one menu,
each reseller page in the section it belongs to — first built as a
"my account / my reseller" switcher, reversed the same day.

1. **Whose reseller, from the address; nothing is stored.** `workspaceOfPath`:
   `/my-resellers/:id/…` is the path's — except the platform's own users
   page, which shares the address (F-311-ab) — else the caller's own
   (`/reseller`, rule 0), else an owner's one terminated reseller by id. On a
   reseller's domain only its own counts: a `/my-resellers` address there is
   the 404 (rule 1). None before `me` and the owned list answer.
2. **One "reseller" button in `account` that opens to its pages**
   (`RESELLER_MENU`, `resellerMenu`, an N3 group; user, 2026-10-08). It
   replaced the first build, which spread the links over five sections —
   "reseller …" and a slug on every row, truncating into each other in a
   288px sidebar. The button carries the slug and, until setup is
   complete, its count (UX-2-e); it opens by itself on any of its pages
   (the group holding the current page is open). Under it, short labels
   in working order: home, setup (while incomplete), catalog, gateways
   (only those it sells with — its billing with the platform is the
   session's tenant), users, team (F-1201-c), roles (F-1201-d), access log (AC-1-p, `audit.read`), domains, bot, brand, settings. The full label
   ("reseller catalog") stays wherever the button is not around it: pins,
   the palette, the breadcrumb ("my account › reseller › …",
   `RESELLER_MENU_GROUP`). A page the account menu already holds (a staff
   seat's `/reseller/users`) is not drawn twice. A pinned one with no
   reseller in play is not drawn and stays in `ui.pins` (N5).
3. **"Open my panel" — the handoff (F-061-f) — follows its pages, inside
   the button**, offered only on the platform, only for a reseller the
   caller owns, and only enabled where it lands (`hasPanel` on
   `GET /auth/handoff`, the `panelHostOf` `POST` refuses on); otherwise a
   line under it says to connect and verify the domain first — never a
   refused click. None on a reseller's own domain: nowhere to hand off to
   (F-061-m).
4. **More than one owned reseller** (a terminated one beside the live one):
   after it, on the platform, one link per slug picks whose pages are drawn.

## Whose page it is — said once (UX-2-a2)

An owner who is also the platform's admin has two users pages, two
catalogs, two gateway lists. Data never crosses — each page is by its
address's tenant, and the services admit by it (invariant 21) — so what
has to stay clear is what the person sees.

1. **One answer, one place.** `ResellerWorkspaceProvider` (in the panel
   layout) decides whose reseller (rule 1 above) and whether the address is
   inside it. The menu and the palette (`useVisibleMenu`), the dashboard,
   the handoff and `PageHeader` read it; nothing computes it again.
2. **Every reseller page is tagged by its address, not by the page.**
   `PageHeader` draws "reseller · slug" above the title on any page inside
   the workspace, so a new workspace page is labelled without opting in.
   The platform's own users page shares the `/my-resellers` address and is
   not tagged.
3. **The breadcrumb reads the reseller's links first** inside the
   workspace: `/reseller/users` is "people › reseller users", never the
   account's "users" — a staff seat's account menu holds that address too.
4. **A new reseller page is one `RESELLER_MENU` row** (section, label,
   path builder) and a page under the workspace; menu, palette, tag and
   trail follow. `reseller-menu.test.tsx` fails on a row with no page.

## Home and settings (UX-2-b)

The home's card stack moved to a page of its own, so the menu's settings
section has one; the home keeps what says how far the reseller is.

1. **Home** (`OnboardingConsoleView`, `/reseller`): the gate's state, a
   progress bar — the route's required steps done of all of them, counted at
   render, never stored — the required, recommended and optional steps, then
   shortcuts: settings, brand, users.
2. **Settings** (`ResellerSettingsView`, `/reseller/settings` and
   `/my-resellers/:id/settings`): operating currency, time zone, limits,
   product quotas, the cap on extras, package change, users' self-move
   ([contract.self-move.md](contract.self-move.md), F-410-f), support access — each
   card by the path's reseller, admitting and refusing on its own
   (invariant 21). The menu links it in `account`, before the brand.
3. **Last on settings: «export my data»** (F-212-c, `DataExportCard`;
   tenant `contract.data-export.md`). Ask, the list, download. The 24 h
   clock is the service's `nextAllowedAt`; a link is minted on the click
   (audited, 5 minutes), only for `ready`; the list re-reads on
   `tenant.data_export.changed` on the caller's `user:` channel, this
   reseller's only (C-14). A `not_allowed` list — a staff seat — draws
   nothing. Proof: `my-resellers/data-export.test.tsx`.

## The setup wizard (UX-2-c)

User, 2026-10-08: a wizard rather than a checklist to tick off.
`/reseller/setup` and `/my-resellers/:id/setup` (`SetupWizardView`).

1. **The route's steps, in the route's order, one at a time** (F-213):
   `GET /api/tenants/:id/onboarding` names them; the wizard adds none and
   reorders none. Every step can be opened from the rail — none waits on
   another, and only the domain gates (`contract.onboarding.md`).
2. **It opens at the first step not done; "later" stores nothing.** The
   checklist is live, so it already knows where to resume
   (`firstUndoneIndex`). A re-read never moves the person off their step.
3. **The progress bar is the route's count** — required steps done of all
   of them (`requiredCount`), the home's and the menu row's own figure —
   never the step index. All done: a finished screen in place of the steps.
4. **Motion is the panel's** (M1–M3): the step slides in from the side it is
   walked toward, mirrored right-to-left; at `reduced` it fades only
   (`setupSlide`). It is a page, not the kit's K12 dialog: nothing is
   submitted at the end — each step's own form saves itself — so it uses
   `useWizard` for the step and direction and draws its own frame.
5. **The domain step is the domains page's own body** (`DomainsPanel`):
   add, the records with copy, "check now". `tenant.domain.changed` re-reads
   the checklist (`useLiveReread`, C-14) on the same channels the page uses,
   so a domain the sweep verifies says "open" without a refresh.
6. **The way in** is a link on the home while `complete` is false.
7. **Every step is its screen's own form, no new route** (UX-2-d):
   gateways and the catalog through their surfaces with `embedded` (no
   page frame or title, the actions kept) and `onChanged` (after a save
   and the re-read); the bot through `BotPanel`. A save there, and every
   move the person makes between steps, re-reads the checklist quietly —
   nothing reports a gateway or a bot live. The catalog loads only when
   its step is opened.
8. **The brand screen comes last and counts toward nothing**
   (`BrandingPanel`): not a route step, so never in the progress bar. A
   fully set-up reseller lands on it, under the finished screen.
9. **Setup progress in the menu, until complete** (UX-2-e): a "reseller
   setup · done/total" row in `account` after the home, opening the
   wizard (`RESELLER_SETUP_LINK`); gone once `complete`, and never drawn
   before the first answer. `ResellerWorkspaceProvider` reads it once
   for the reseller in play (`useResellerSetup`), again on
   `tenant.domain.changed` and when a page that saved asks
   (`rereadSetup` — the wizard does). So the provider sits inside the
   socket's (`layout.tsx`).
10. **The gate lifting is celebrated once, live** (M5): confetti and a
    toast when one answer says shut and the next says open
    (`gateOpened`) — never on the first read, so a reseller opened
    yesterday is not celebrated on every load.
11. **A bought reseller lands in the wizard**: the purchase screen's
    button is `afterPurchasePath` — `/reseller/setup`, whose first step
    is now «bring my users» (rule 12), then the domain.
12. **«Bring my users», the optional first step** (F-213, `ImportStep`):
    the way to this reseller's migration page and "I have no users to
    bring" — a stored skip (`resellerOnboardingApi.skip`), shown as
    skipped with an undo; done by an import, neither. Labelled optional,
    a dashed rail mark, and counted nowhere (user, 2026-10-22); a skip or
    undo re-reads the checklist like any step's save.

## Proof

`my-resellers/self-workspace.test.tsx` (paths, the redirect and 404s, the
menu's users entry), `_components/reseller-menu.test.tsx` (whose links, their
sections, the handoff on both hosts, every link's page),
`_components/reseller-scope.test.tsx` (the header's tag and trail, UX-2-a2),
`my-resellers/workspace-home.test.tsx` (home and settings, UX-2-b),
`my-resellers/setup-wizard.test.tsx` (the wizard, UX-2-c),
`my-resellers/setup-steps.test.tsx` (its steps' forms and the brand screen, UX-2-d),
`my-resellers/setup-progress.test.tsx` (the menu row, the celebration, after buying, UX-2-e),
`my-resellers/setup-import.test.tsx` (the optional import step and its skip, F-213),
`handoff.service.spec.ts` (`hasPanel`).
