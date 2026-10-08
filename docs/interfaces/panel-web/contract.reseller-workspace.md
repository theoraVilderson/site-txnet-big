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
addresses it has and the switcher and menu that lead through it.

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

## The workspace switcher and the reseller menu (UX-2-a)

It replaced the sidebar's "my reseller" block and the workspace's tab bar
(`contract.ux.md` N8) — one reseller's screens are a menu of their own, not
one button and then tabs (user, 2026-10-08: the switcher over a menu section).

1. **The address picks the menu; nothing is stored.** `workspaceOfPath`:
   `/reseller/…` is the caller's own (rule 0), `/my-resellers/:id/…` the
   path's — except the platform's own users page, which shares the address
   (F-311-ab) and stays the account's. On a reseller's domain only `/reseller`
   counts: a `/my-resellers` address there is the 404 (rule 1).
2. **The switcher** opens the nav: "my account" (`/`) and "my reseller", the
   current one marked (`aria-current="true"` — a workspace, not a page).
   "My reseller" goes to the workspace in the path, else `/reseller`, else —
   an owner whose one reseller is terminated — that one by id. Not drawn for
   a caller with none, nor before `me` and the owned list answer.
3. **Inside a workspace the sidebar draws `RESELLER_MENU`** (`_lib/reseller-menu.ts`)
   instead of the account's: home & setup, sales (catalog), finance
   (gateways only — tenant billing is the session's tenant, not the path's),
   customers (users), infrastructure (domains, bot), settings (settings, brand). Headed
   sections that fold under their own ids (`reseller-<id>`); no pins and no
   footer entries — those are the account's; logout stays.
4. **"Open my panel" — the handoff (F-061-f) — sits in home**, offered only
   on the platform, only for a reseller the caller owns, and only enabled
   where it lands (`hasPanel` on `GET /auth/handoff`, the `panelHostOf`
   `POST` refuses on); otherwise a line under it says to connect and verify
   the domain first — never a refused click. None on a reseller's own domain:
   there is nowhere to hand off to (F-061-m).
5. **More than one owned reseller** (a terminated one beside the live one):
   under the switcher, on the platform, one link per slug picks which.

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
   (invariant 21). The menu's settings section links it before the brand.

## Proof

`my-resellers/self-workspace.test.tsx` (paths, the redirect and 404s, the
menu's users entry), `_components/workspace-switcher.test.tsx` (the path's
menu, the switcher and the handoff on both hosts, every entry's page),
`my-resellers/workspace-home.test.tsx` (home and settings, UX-2-b),
`handoff.service.spec.ts` (`hasPanel`).
