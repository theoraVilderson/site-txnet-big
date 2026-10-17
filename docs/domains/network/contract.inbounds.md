---
id: network
layer: domain
status: active
version: 21
updated: 2026-10-17
---

# Inbounds: which ones a buyer is placed on (F-114-b)

A topic file of `contract.md` (§10), beside `contract.groups.md` and
`contract.provisioning.md`. What governs `network.panel_inbound`, the panel's
`inboundPlacement` / `maxClients` / `inboundsReadAt`, and `config.inboundRemoteId`
(migration `20260925001200_a_panel_names_the_inbounds_it_sells`).

Reported 2026-09-25: the system did not know which v2ray inbounds to create a
user on — the pass took the first enabled inbound of the group's one protocol.
Decided the same day (user): **the pick lives on the panel**, every group that
holds the panel inherits it, and a panel with nothing picked places nobody.

## The tables

| where | columns | who writes |
|---|---|---|
| `panel_inbound` | key `(panelId, remoteId)`; `tag`, `protocol` (null = one we do not sell), `port`, `host`, `enabled`, `goneAt`, `seenAt`, `fingerprint` (what its lines are built from; `contract.links.md` rule 6b) | `network-service`'s read |
| `panel_inbound` | `sold`, `maxClients` (null = no cap, else `>= 1`) | the admin, on billing's systems routes |
| `panel` | the panel's layer of the selling settings (rule 4a): `inboundPlacement` (`all` \| `spread` \| `hrw`), `maxClients` (`>= 1`), `priority` (`>= 0`), `weight` (`>= 1`), `inboundsPerBuyer` (`>= 1`, K under `hrw`); null = the platform default | the admin |
| `panel_group_member` | the member's layer: the same five, null = the panel's; its `maxClients` counts the group's own Grants (rule 5) | the admin |
| `panel_inbound` | `audience` — `every_group` (default) or `listed` (rule 3a) | the admin |
| `panel_group_member_inbound` | a `listed` inbound's sellers: key `(groupId, panelId, inboundRemoteId)`, an inbound listed to any number of memberships; only on a `listed` inbound (trigger `panel_group_member_inbound_is_listed`); `tenantId` = its member's (trigger); both FKs cascade (rule 3a); `maxClients` = the group's share of it (null = none, else `>= 1`; rule 5) | the admin |
| `panel` | `inboundsReadAt` — null = read on the next pass | the read sets it; the admin's refresh clears it |
| `config` | `inboundRemoteId` — the inbound fulfilment placed it on | `ConfigActionsService.provisionForGroup` |

`panel_inbound.tenantId` is the panel's, copied by trigger
(`panel_inbound_tenant`, `panel_inbound_follows_panel`); policied as
`network.panel` is: shared-read for `txnet_app`, all for `txnet_cross_tenant`.

## The rules

1. **The panel's inbounds are read, never typed.** The convergence pass writes
   `ListInbounds` into `panel_inbound` when `inboundsReadAt` is null or older
   than `converge.InboundReadEvery` (2 min: an edited inbound's fingerprint is
   how 3x-ui v3 lines follow the panel, `contract.links.md` rule 6b), reusing
   the read a create already made. A listed inbound is upserted (its `goneAt` cleared), an unlisted one
   gets `goneAt`, and **the read never touches `sold` or `maxClients`**: an
   inbound that disappears and returns keeps its pick. A failed read is logged
   and never fails the pass. A push panel is never called, so it has none.
2. **Only a sellable inbound is sold.** Sellable = not gone and of a
   `ConfigProtocol`; billing refuses a pick on any other (`inbound_not_sellable`).
   Fulfilment loads only inbounds `sold`, `enabled`, not gone, protocol not
   null — a disabled one keeps its pick and takes nobody until it is enabled.
3. **Nothing picked, nobody placed.** A member with no loaded inbound is
   `waiting` (`no_inbound`), never given the first enabled inbound. A group's
   protocols are its members' picks'; `panel_group.protocol` is dropped.
3a. **An inbound is sold by every group, or by the groups it lists** (F-027-ep,
   ADR-0127 decisions 1-2; F-027-ch before it). `audience = every_group` is
   sold by every membership of its panel while `sold`, a group that joins later
   included; `audience = listed` is sold by exactly the memberships listing it
   (`panel_group_member_inbound`) — none, one or several, so one router's
   OpenVPN serves the groups chosen. A membership sells its listings (enabled,
   not gone; `sold` is not asked of a listed one) **plus** every `every_group`
   one. The two never mix: a listing only on a `listed` inbound, and
   `every_group` only once nobody lists it (triggers). The writes are billing's
   (`contract.panel-groups.md` rule 24c) under the panel's fulfilment lock
   (rule 5): one membership's whole set of listings — naming an `every_group`
   inbound lists it to that group alone — and one inbound's audience. Adding a
   seller is always allowed; a group that would **lose** an inbound while
   live configs (`present`, not drained) of its Grants are on it is 409
   `inbound_has_configs`, with the group and the count, and `groups`, every
   group losing it with its own — a client whose row does not yet name its
   inbound (rule 7) counts on every inbound of its protocol. The way out is a
   release job, `move` or `empty`, that changes the listing when it ends; while
   it runs, `inbound_release` holds those groups off the inbound
   ([contract.config-move.md](contract.config-move.md), F-027-es). Losing the last listing leaves it `listed` to nobody, never every
   group's by itself. The migration moved nobody: an assigned inbound became
   `listed` to its group, and on a panel with any assignment the pool became
   `listed` to the members without one. `sold` and the inbound's `maxClients`
   stay the inbound's. `sellingInbounds` (billing `traffic/selling-settings.ts`)
   is the one resolution; fulfilment, the due scan and catalog's `protocols`
   read by it. `member-inbounds.spec.ts` pins it, a router listed to two groups
   included.
4. **The placement.** `all`: the Grant gets a config on every picked inbound
   it is not yet on — one link each, the bag split across them
   (`contract.ceiling.md`). `spread`: one config, on the picked inbound with
   the fewest live configs that is under its cap (ties: the lower id). `hrw`:
   K of them (rule 4b). A config's `protocol` is its inbound's.
4a. **Three layers, and always an answer** (F-027-cg, ADR-0090 decision 2).
   A selling setting resolves group membership -> panel -> platform default
   (`PLATFORM_SELLING_DEFAULTS` in billing's `traffic/selling-settings.ts`:
   `all`, no cap, priority 0, weight 1, 2 per buyer); null at a layer is "not set here".
   So one panel can place `all` for one group and `spread` with a lower cap for
   another. Server facts — addresses, credentials, `maxRequestsPerMinute`,
   `maxLineRateBps` — have no member column and are never overridden. A member
   cap is not one value but two (rule 5): the member's is its group's share,
   the panel's stays physical, and both hold. The due
   scan resolves the three `mirror` reads in SQL (`COALESCE`), which assumes the
   platform cap is none; `placementSettings` does it in TypeScript, and rules 4
   and 5 read the effective values. Which inbounds a member sells is rule 3a.
4b. **`hrw`: K of N by the Grant's rendezvous hash** (F-027-di, SPEC weakness
   #24, #25). K is `inboundsPerBuyer` (rule 4a; platform 2, at most 16 — K = N
   is `all`). Each picked inbound the Grant is not on, with a seat, is ranked
   by weighted rendezvous hashing of `(grantId, remoteId)`, every weight 1
   (billing `traffic/hrw.ts`), and the top `K - held` are placed. **Every
   un-drained config of the Grant on the panel counts towards K, wherever it
   is**, so an inbound disabled, gone or unticked moves nobody (rule 6): the
   buyer keeps serving on the rest. Once that config is drained or retired,
   the next run places that buyer alone on its next-ranked inbound — no other
   buyer's rank changed. Fewer picks than K: one on each, nothing owed after.
   The due scan asks the same "fewer than K" in SQL. The hash is the Go
   reference's (`network-service/internal/lease/hrw`) bit for bit:
   `contracts/network/hrw.json` holds cases it produced, read by `hrw.spec.ts`
   and the Go `contract_test.go`. A row with no `inboundRemoteId` holds its
   panel under `hrw` as under `all` (rule 7). `group-fulfilment.spec.ts` pins it.
5. **The caps — physical, and the group's share** (F-027-eq, ADR-0127
   decision 3). Live = `present`, not drained. Physical, over every Grant of
   every group and tenant: an inbound at its `maxClients` live configs takes
   nobody; a panel at its own layer's `maxClients` (else the platform's, none)
   users — distinct Grants with a live config — takes no **new** Grant. The
   group's share, over that group's Grants alone (`grant.panelGroupId`): a
   listing's `maxClients` caps the group's live configs on that inbound, a
   member-layer `maxClients` the group's users on the panel. So one busy group
   never uses up another's room. **Every cap that applies must have room**; a
   Grant already on the panel still gets a pick added later (an inbound's caps
   still hold for it). A share is set by billing (`contract.panel-groups.md`
   rule 24f); one below what is placed moves nobody. Counted after a
   transaction lock on each placeable panel (`pg_advisory_xact_lock`, panel-id
   order), so two fulfilments never take one inbound's last seat together.
   `group-fulfilment.spec.ts` pins both kinds; `planFulfilment` is
   `traffic/group-plan.ts`.
6. **A pick reaches the next placement.** Ticking an inbound gives existing
   Grants a config on it at the next sweep (`all`); unticking one stops new
   placements and moves nobody — a move is `retire`/`move`, a decision of its
   own. Covered = any config of the Grant on that inbound (`spread`: on the
   panel), except a drained one (`contract.groups.md` rule 9);
   `config_group_panel_once` is keyed `(grantId, panelId, inbound)`.
7. **A config is created on its own inbound.** The pass creates the client on
   `inboundRemoteId` only if the panel still lists it enabled with the
   config's protocol, else `no_inbound`. A row placed before F-114-b has none:
   to create its client the pass reads the lowest picked inbound of its
   protocol that is **`every_group`** — never a listed one (rule 3a) — and with none
   it too is `no_inbound`. Such a row covers its whole panel only until the
   pass **writes down the inbound its client is on** (found, or just created;
   only over null, and not where another live row of the Grant holds it —
   `config_group_panel_once`). From then it is an ordinary row: under `all`
   the Grant is given the panel's other picks, as any buyer (user,
   2026-09-26). Which group such a row is for lives outside `network.*`
   (ADR-0071), so its own group's listed inbounds are not offered to it.
8. **Activation counts panels.** `minHealthyPanels` is met by distinct panels
   with a confirmed config, never by configs — `all` puts several on one.

## Who writes a pick

The platform owner, on billing's systems routes (`billing/contract.systems.md`
rule 25) from the panel list's "Inbounds" on `/systems` (panel-web
`contract.systems.md` rule 12).
