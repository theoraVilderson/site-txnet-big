---
id: billing
layer: domain
status: active
version: 51
updated: 2026-10-26
---

# Systems — a reseller's own panels

A topic file of `contract.md` (§10), beside [contract.systems.md](contract.systems.md)
and [contract.panel-groups.md](contract.panel-groups.md). ADR-0166 (BYO-1-b):
a reseller registers and manages its own panels as the platform owner does.

## The door

| Rule | Why |
|---|---|
| 1. Every route of the systems surface is mounted twice: `/api/billing/systems/…` (the owner's) and `/api/billing/tenants/:tenantId/systems/…` (a reseller's). Same controllers, same bodies, same answers — `SystemsDoorGuard` (`systems-door.ts`) picks the door from the path | one route list, so the two cannot drift |
| 2. A reseller's door is `ResellerAccess.for('node.manage').asStaff('platform.node.manage')`: the reseller's owner, a member holding `node.manage`, or the platform's staff holding `platform.node.manage`. `GET` asks `read`, every other method `staffWrite`. Refusals are every reseller route's: 403 `not_allowed` / `consent_required`, 404 `reseller_not_found` | the reseller-route door, with the owner's own key for its staff |
| 3. The actor's tenant is the **path's**, never the session's — a reseller's owner signs in on the platform's tenant (ADR-0059). `systemsActorOf` throws on a request the guard did not admit | acting on the session's tenant would be the platform's panels |
| 4. `grants/…` (moving Grants between groups, F-027-et) stays on the owner's path only; a reseller moves its own through `reseller-grant-group-move` | it reaches every tenant's Grants |

## The scope

| Rule | Why |
|---|---|
| 5. `panelScopeOf` answers `{ownershipType: tenant, tenantId}` for a reseller's tenant, the platform's scope for the platform's, and refuses any other (`not_platform_owner`, 403) | ADR-0080 decision 2 foresaw this change and no other |
| 6. Every read of `network.panel` and `network.panel_cost` is on the cross-tenant pool with the scope in its `where`; drift events and holds (no RLS) by the in-scope panels' ids | the middleware scopes the request to the session's tenant: a reseller's panel is invisible to a bare app-pool read |
| 7. A reseller's group holds only its own panels and the platform's only the platform's: a member outside the actor's panel scope is `panel_not_found` (user, 2026-10-26) | a group never mixes owners, so a sale is wholesale-charged or not as a whole (F-118-n6) |
| 8. Registration past `panels_max` is 409 `reseller_limit_reached` (BYO-1-a, `tenant/contract.limits.md`) | the collector reads every panel registered |
| 9. Unchanged for a reseller's panel: the connection test and its verdict on the tenant's channel, the bare dial guard (no private address, ADR-0095), `report_only` for orphans | ADR-0166 point 6 |
