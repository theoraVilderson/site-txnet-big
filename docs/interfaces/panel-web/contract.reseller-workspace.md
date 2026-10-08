---
id: panel-web
layer: interface
status: active
version: 1
updated: 2026-10-08
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
   reseller's tenant, so for it `me` says it, with `tenant.manage`
   (`selfResellerOf`). Read once per account and shared (`ownedResellersOf`),
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
2. **Each link joins an N1 section** (`RESELLER_MENU`, `withResellerMenu`):
   home, settings, brand → `account`; catalog → `sales`; gateways →
   `finance` (only those — tenant billing is the session's tenant, not the
   path's); users → `people`; domains, bot → `infra`. Drawn after the
   section's own entries, labelled "reseller …" beside the account's
   catalog or gateways, and tagged with its slug. A link the account menu
   already holds (a staff seat's `/reseller/users`) is not drawn twice. It
   pins like any entry; a pinned one with no reseller in play is not drawn
   and stays in `ui.pins` (N5).
3. **"Open my panel" — the handoff (F-061-f) — follows them in `account`**,
   offered only on the platform, only for a reseller the caller owns, and
   only enabled where it lands (`hasPanel` on `GET /auth/handoff`, the
   `panelHostOf` `POST` refuses on); otherwise a line under it says to
   connect and verify the domain first — never a refused click. None on a
   reseller's own domain: nowhere to hand off to (F-061-m).
4. **More than one owned reseller** (a terminated one beside the live one):
   after it, on the platform, one link per slug picks whose links are drawn.

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
   progress bar — the route's steps done of all of them, counted at render,
   never stored — the required and recommended steps, then shortcuts:
   settings, brand, users.
2. **Settings** (`ResellerSettingsView`, `/reseller/settings` and
   `/my-resellers/:id/settings`): operating currency, time zone, limits,
   product quotas, the cap on extras, package change, support access — each
   card by the path's reseller, admitting and refusing on its own
   (invariant 21). The menu links it in `account`, before the brand.

## Proof

`my-resellers/self-workspace.test.tsx` (paths, the redirect and 404s, the
menu's users entry), `_components/reseller-menu.test.tsx` (whose links, their
sections, the handoff on both hosts, every link's page),
`_components/reseller-scope.test.tsx` (the header's tag and trail, UX-2-a2),
`my-resellers/workspace-home.test.tsx` (home and settings, UX-2-b),
`handoff.service.spec.ts` (`hasPanel`).
