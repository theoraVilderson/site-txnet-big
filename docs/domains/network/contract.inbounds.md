---
id: network
layer: domain
status: draft
version: 19
updated: 2026-09-25
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
| `panel_inbound` | key `(panelId, remoteId)`; `tag`, `protocol` (null = one we do not sell), `port`, `host`, `enabled`, `goneAt`, `seenAt` | `network-service`'s read |
| `panel_inbound` | `sold`, `maxClients` (null = no cap, else `>= 1`) | the admin, on billing's systems routes |
| `panel` | the panel's layer of the selling settings (rule 4a): `inboundPlacement` (`all` \| `spread`), `maxClients` (`>= 1`), `priority` (`>= 0`), `weight` (`>= 1`); null = the platform default | the admin |
| `panel_group_member` | the member's layer: the same four, null = the panel's | the admin |
| `panel_group_member_inbound` | key `(groupId, panelId, inboundRemoteId)`, unique `(panelId, inboundRemoteId)`; `tenantId` = its member's (trigger); both FKs cascade (rule 3a) | the admin |
| `panel` | `inboundsReadAt` — null = read on the next pass | the read sets it; the admin's refresh clears it |
| `config` | `inboundRemoteId` — the inbound fulfilment placed it on | `ConfigActionsService.provisionForGroup` |

`panel_inbound.tenantId` is the panel's, copied by trigger
(`panel_inbound_tenant`, `panel_inbound_follows_panel`); policied as
`network.panel` is: shared-read for `txnet_app`, all for `txnet_cross_tenant`.

## The rules

1. **The panel's inbounds are read, never typed.** The convergence pass writes
   `ListInbounds` into `panel_inbound` when `inboundsReadAt` is null or older
   than `converge.InboundReadEvery` (10 min), reusing the read a create already
   made. A listed inbound is upserted (its `goneAt` cleared), an unlisted one
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
3a. **An inbound is the pool's or one group's** (F-027-ch, ADR-0090 decision 3).
   An inbound assigned to a membership (`panel_group_member_inbound`) leaves
   the panel's **default pool** — `sold` inbounds no membership holds — and
   only that group places on it. A membership with an assignment sells its
   own inbounds and never the pool, even when all of them are disabled; one
   with none sells the pool, which is shared on purpose. The unique
   `(panelId, inboundRemoteId)` holds "one group at most" against a race. The
   write is billing's (`contract.systems.md` rule 24c), the whole set at once
   under the panel's fulfilment lock (rule 5): a named inbound held by another
   membership is 409 `inbound_assigned_elsewhere` naming that group, one with
   live configs (`present`, not drained) of another group's Grants is 409
   `inbound_has_configs` with their count. Unassigning is always allowed and
   moves nobody (rule 6). `sold` and the inbound's `maxClients` stay the
   inbound's: the cap binds whichever group sells it. Before F-027-ch every
   group sold the pool, and that is the table empty, so nothing moved.
   `sellingInbounds` (billing `traffic/selling-settings.ts`) is the one
   resolution; fulfilment, the due scan and catalog's `protocols` read by it.
   `member-inbounds.spec.ts` pins it.
4. **The placement.** `all`: the Grant gets a config on every picked inbound
   it is not yet on — one link each, the bag split across them
   (`contract.ceiling.md`). `spread`: one config, on the picked inbound with
   the fewest live configs that is under its cap (ties: the lower id). A
   config's `protocol` is its inbound's.
4a. **Three layers, and always an answer** (F-027-cg, ADR-0090 decision 2).
   A selling setting resolves group membership -> panel -> platform default
   (`PLATFORM_SELLING_DEFAULTS` in billing's `traffic/selling-settings.ts`:
   `all`, no cap, priority 0, weight 1); null at a layer is "not set here".
   So one panel can place `all` for one group and `spread` with a lower cap for
   another. Server facts — addresses, credentials, `maxRequestsPerMinute`,
   `maxLineRateBps` — have no member column and are never overridden. A member
   cannot set "no cap" under a capped panel: unset inherits the cap. The due
   scan resolves the two `mirror` reads in SQL (`COALESCE`), which assumes the
   platform cap is none; `placementSettings` does it in TypeScript, and rules 4
   and 5 read the effective values. Which inbounds a member sells is rule 3a.
5. **The caps.** An inbound at `maxClients` live configs takes nobody. A panel
   at its effective `maxClients` (rule 4a) users — distinct Grants with a live config (`present`, not
   drained) — takes no **new** Grant; a Grant already on it still gets a pick
   added later. Counted across every tenant, after a transaction lock on each
   placeable panel (`pg_advisory_xact_lock`, panel-id order), so two
   fulfilments never take one inbound's last seat together.
6. **A pick reaches the next placement.** Ticking an inbound gives existing
   Grants a config on it at the next sweep (`all`); unticking one stops new
   placements and moves nobody — a move is `retire`/`move`, a decision of its
   own. Covered = any config of the Grant on that inbound (`spread`: on the
   panel), except a drained one (`contract.groups.md` rule 9);
   `config_group_panel_once` is keyed `(grantId, panelId, inbound)`.
7. **A config is created on its own inbound.** The pass creates the client on
   `inboundRemoteId` only if the panel still lists it enabled with the
   config's protocol, else `no_inbound`. A row placed before F-114-b has none:
   the pass reads the lowest picked inbound of its protocol, and with none
   picked it too is `no_inbound`. Such a row covers its whole panel.
8. **Activation counts panels.** `minHealthyPanels` is met by distinct panels
   with a confirmed config, never by configs — `all` puts several on one.

## Who writes a pick

The platform owner, on billing's systems routes (`billing/contract.systems.md`
rule 25) from the panel list's "Inbounds" on `/systems` (panel-web
`contract.systems.md` rule 12).
