---
id: network
layer: domain
status: draft
version: 17
updated: 2026-09-24
---

# Panel groups: where a variant's Grants are provisioned (catalog §7.3)

A topic file of `contract.md` (§10), beside `contract.provisioning.md`. What
governs `network.panel_group` / `network.panel_group_member` and the
`catalog.product_variant.panelGroupId` that names one. The schema is F-027-bk
(migration `20260924000900_a_variant_is_provisioned_on_a_panel_group`);
fulfilment is F-027-bl (below), draining F-027-bm.

## The tables

| table | columns that matter | held by |
|---|---|---|
| `panel_group` | `tenantId` (null = platform), `name`, `strategy` (`mirror` default), `minHealthyPanels` (default 1), `subscriptionTtlSeconds` (default 3600), `protocol` (`ConfigProtocol`, default `vless`) | CHECK `minHealthyPanels >= 1`, `subscriptionTtlSeconds > 0`; trigger `panel_group_tenant_is_fixed` |
| `panel_group_member` | key `(groupId, panelId)`; `tenantId` = its group's; `priority` (default 0, lower first), `weight` (default 1), `role` (`primary` default) | CHECK `priority >= 0`, `weight >= 1`; trigger `panel_group_member_fits` |

Both are policied as `network.panel` is: shared-read for `txnet_app` (its own
tenant's rows and the platform's), everything for `txnet_cross_tenant`.

## The rules

1. **A panel is in a group once.** The key is `(groupId, panelId)`: two rows
   for one panel would make fulfilment create two configs on it.
2. **Tenancy follows the panels.** A platform group (`tenantId` null) holds
   platform panels only; a tenant's group holds its own panels and platform
   ones. The member carries its group's tenant, so RLS reads it without a join.
   A platform group holding one reseller's dedicated panel would serve every
   tenant's users from it — `panel_group_member_fits` refuses it, and
   `panel_keeps_its_groups` refuses giving a platform panel to a tenant while
   another tenant's group (or a platform group) holds it.
3. **A group's tenant never changes.** Variants and members were admitted
   against it.
4. **A variant names a platform group or its own tenant's.** Held twice:
   `catalog.variant_panel_group_fits` in the database, and catalog-admin's
   `panel_group_not_found` (404, as another tenant's variant is not found) for
   the caller. The FK is `ON DELETE RESTRICT`: a group a variant still names is
   not deleted.
5. **The triggers refuse what they cannot see.** They run as the caller, under
   RLS, where another tenant's panel or group is simply absent; *not found* is
   therefore a refusal, never a pass.
6. **`role` is the member's, not the panel's.** `PanelGroupMemberRole`
   (`primary | replica | drain`) is apart from `Panel.role` (`PanelRole`, an HA
   pair's `active | passive`). `drain` takes no new Grants (F-027-bm).
7. **Three strategies are declared; one is built.** `mirror` places a config on
   every non-drain healthy member and reads neither `priority` nor `weight`
   (F-027-bl). `priority` and `weighted` were declared on the user's call
   (2026-09-24) **with no fulfilment behind them**: until a row builds one, a
   group set to either must be refused by whatever reads it, not treated as
   `mirror`.

## Fulfilment — `GroupFulfilmentService` (billing-service, F-027-bl)

`billing-service/src/app/traffic/group-fulfilment.ts`. Desired state only: the
rows are written through `ConfigActionsService.provisionForGroup`
(`contract.provisioning.md`), and the convergence pass creates the clients.

8. **`mirror` places one config on every member that is not `drain`, whose
   panel is `accepted`/`accepted_low_trust` and `healthy`**, with the group's
   `protocol`. Every config of the placement carries one `credentialGroupId`
   (the first one's, else a new uuid), and the Grant is rebalanced once for the
   lot, so no client is created without its share.
9. **A panel with any config of the Grant is covered**, whatever its status. A
   row still `pending` on a panel that died mid-provisioning is the pass's to
   finish when it returns; a `retired` one was a delete or a move, and a refill
   would undo it. The planner's read is not enough under an at-least-once job:
   partial unique `config_group_panel_once` `(grantId, panelId) WHERE
   credentialGroupId IS NOT NULL` refuses the second of two concurrent runs,
   whose transaction rolls back whole.
10. **A `pending` Grant is provisioned, and activates on the panels' word.** It
    moves to `active` once `minHealthyPanels` of its configs are `active`,
    `present`, `complete` on a member whose panel still serves — sub-api's
    `servingPanelStates` (`healthy`, `degraded`, `throttled_or_blocked`).
    `complete` is a read (invariant 36), so a Grant is never activated on our
    own write. The move is conditional on `pending`, so a cancel meanwhile
    stands. An `active` Grant (a gift) is placed and left as it is; any other
    status is `grant_not_fulfillable`.
11. **The retry is the sweep.** `POST /api/internal/billing/network/fulfil-due`
    (`ServiceOnlyGuard`), asked every minute by `worker-service`'s
    `grant_group_fulfilment`, names only Grants with a write due: a placeable
    member with no config of the Grant, or a `pending` Grant at its minimum. A
    member that is down is `waiting` and costs no batch slot; it is filled on
    the tick after it is `healthy` again. Panel-side backoff is the pass's own
    (`contract.budget.md`). One Grant's failure is counted in `grantsFailed`
    and named again next tick. Answer: `scanned`, `configsPlaced`,
    `grantsActivated`, `grantsFailed`.
12. **`priority` / `weighted` are refused** (`strategy_not_built`) by `fulfil`,
    and the sweep does not name them (rule 7).

Refusals are `GROUP_FULFILMENT_REJECTIONS`: `grant_not_found`,
`grant_not_fulfillable`, `no_panel_group`, `strategy_not_built`.

**Not reachable end to end yet:** `network-service` does not yet run the
convergence pass against `network.config` (`MemoryDesired` staging,
`contract.provisioning.md`), so no config reaches `complete` and no Grant
activates on a live stack until F-027-bo wires it.

## Not decided here

The drain wait and removal (F-027-bm), what `priority` / `weighted` place, and
whether a member added later reaches Grants already placed (today: yes, on the
next tick — the sweep reads the group as it is).
