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
addresses it has and the sidebar block that leads to it.

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

## The sidebar's reseller block (`ResellerPanelButton`)

At the top of the nav, above the pins — a workspace, not a footer action
beside logout. Titled "my reseller".

1. **On the platform, per owned reseller:** its slug, then two actions kept
   apart — **reseller settings** (a link, current anywhere inside that
   workspace) and **open its panel** (the handoff, F-061-f).
2. **The handoff is offered only where it lands.** `GET /auth/handoff` says
   `hasPanel` per reseller, by the same `panelHostOf` `POST` refuses on.
   Without one the action is disabled and a line under it says to connect and
   verify the domain first — the click is never refused into the settings.
3. **On the reseller's own domain:** reseller settings only, to `/reseller`.
   No handoff: there is nowhere to hand off to (F-061-m).
4. **Nothing at all** before `me` answers, for a caller who owns no reseller
   on the platform, or for anyone but the owner or a `tenant.manage` seat on
   a reseller's domain.

## Proof

`my-resellers/self-workspace.test.tsx` (paths, the redirect and 404s, the
menu's users entry), `_components/ResellerPanelButton.test.tsx` (the block on
both hosts), `my-resellers/workspace-tabs.test.tsx` (id-less tabs),
`handoff.service.spec.ts` (`hasPanel`).
