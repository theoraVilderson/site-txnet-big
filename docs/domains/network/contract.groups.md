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
(migration `20260924000900_a_variant_is_provisioned_on_a_panel_group`).
**Nothing reads these tables yet:** fulfilment is F-027-bl, draining F-027-bm,
and a variant with a group is still provisioned as it was before.

## The tables

| table | columns that matter | held by |
|---|---|---|
| `panel_group` | `tenantId` (null = platform), `name`, `strategy` (`mirror` default), `minHealthyPanels` (default 1), `subscriptionTtlSeconds` (default 3600) | CHECK `minHealthyPanels >= 1`, `subscriptionTtlSeconds > 0`; trigger `panel_group_tenant_is_fixed` |
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

## Not decided here

How `minHealthyPanels` gates activation and the retry queue (F-027-bl), the
drain wait and removal (F-027-bm), and what `priority` / `weighted` place.
