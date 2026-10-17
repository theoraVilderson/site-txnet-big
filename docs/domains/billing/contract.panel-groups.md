---
id: billing
layer: domain
status: active
version: 51
updated: 2026-10-17
---

# Systems — panel groups

A topic file of `contract.md` (§10), beside [contract.systems.md](contract.systems.md),
whose "Who may call" and rate limits apply here. Where a `network_access`
variant's Grants are placed, as the platform owner manages it:
`billing-service/src/app/systems/panel-groups.ts`. What fulfilment and the
drain sweep do with these rows is network
[contract.groups.md](../network/contract.groups.md). Every route writes
desired state; nothing calls `network-service` (ADR-0071).

## Routes

| Route | Body | Answers | Errors |
|---|---|---|---|
| `GET /api/billing/systems/panel-groups` | — | `[{id, name, strategy, minHealthyPanels, subscriptionTtlSeconds, createdAt, updatedAt, variantCount, members: [{groupId, panelId, panelName, panelState, reviewState, lastHealthyAt, inboundPlacement, maxClients, priority, weight, inboundsPerBuyer, effective, inbounds, role, drainingSince, evictedAt, heldGrants, createdAt}]}]`, by name; members by effective `priority`. The five are the member's own (null = inherited); `inbounds` its listed remote ids, sold beside the every-group ones (rule 24c); `shares: [{remoteId, maxClients}]` the listings with a share (rule 24f); `effective` is `{<setting>: {value, layer}}`, layer `member` \| `panel` \| `platform` (rule 24b); `heldGrants` (rule 24d) | 403 |
| `POST /api/billing/systems/panel-groups` | `name`, `minHealthyPanels?` (1–100), `subscriptionTtlSeconds?` (60–604800); `.strict()` — `protocol` is refused since F-114-b | `201` the group, `strategy: mirror` | 400; 403 |
| `PATCH /api/billing/systems/panel-groups/:id` | any of the three, at least one; `.strict()` | `200` the group | 400; 403; 404 `not_found` |
| `DELETE /api/billing/systems/panel-groups/:id` | — | `200 {id, removed: true}` | 400; 403; 404 `not_found`; 409 `group_has_members` / `group_in_use` |
| `POST /api/billing/systems/panel-groups/:id/members` | `panelId`, and any of `inboundPlacement`, `maxClients` (1–1000000), `priority` (0–1000), `weight` (1–1000), `inboundsPerBuyer` (1–16, K under `hrw`), each nullable; `.strict()` | `201` the member, `primary` | 400; 403; 404 `not_found` / `panel_not_found`; 409 `already_member` |
| `PATCH /api/billing/systems/panel-groups/:id/members/:panelId` | any of those four, at least one; null inherits; `.strict()` — a server fact is refused | `200` the member | 400; 403; 404 `not_found` / `member_not_found` |
| `DELETE /api/billing/systems/panel-groups/:id/members/:panelId` | — | `200 {groupId, panelId, removed: true}` | 400; 403; 404 `not_found` / `member_not_found`; 409 `member_has_configs` |
| `PUT /api/billing/systems/panel-groups/:id/members/:panelId/inbounds` | `inbounds: [remoteId]` (≤500, each once; `[]` = lists none, sells the every-group ones); `.strict()` | `200 {groupId, panelId, inbounds}` | 400; 403; 404 `not_found` / `member_not_found` / `inbound_not_found`; 409 `inbound_not_sellable`, `inbound_has_configs` `facts: {remoteId, groupId, configs, groups: [{groupId, configs}]}` (rule 24c) |
| `PUT /api/billing/systems/panels/:id/inbounds/:remoteId/audience` | `{audience: 'every_group'}` or `{audience: 'listed', groups: [groupId]}` (≤100, each once, each a member of the panel; `[]` = nobody); `.strict()` | `200 {panelId, remoteId, audience, groups}` | 400; 403; 404 `panel_not_found` / `inbound_not_found` / `member_not_found`; 409 `inbound_not_sellable` (listing a gone or unsold-protocol one), `inbound_has_configs` `facts: {remoteId, groupId, configs, groups}` (rule 24g) |
| `POST /api/billing/systems/panels/:id/inbounds/:remoteId/release` | `{requestId, groups: [groupId] (1–100, each once), mode: 'move' \| 'empty', orphans?: 'pause' \| 'refund' (an empty's, required there), reason}`; `.strict()` | **202** the job (rule 24g) | 400 (`selection_too_large` too); 403; 404 `panel_not_found` / `inbound_not_found` / `member_not_found`; 409 `not_a_seller` / `already_releasing` / `request_reused` |
| `GET …/systems/inbound-releases/:jobId`, `…/:jobId/outcomes?page&pageSize&problems`, `POST …/:jobId/cancel` | — | the job (`kind`, `source`, `orphans`, counts) / its outcomes / the job, `cancelled` | 403; 404 `job_not_found` |
| `PUT /api/billing/systems/panel-groups/:id/members/:panelId/inbounds/:remoteId/share` | `{maxClients: 1–1000000 \| null}`; `.strict()` | `200 {groupId, panelId, remoteId, maxClients}` | 400; 403; 404 `not_found` / `listing_not_found` (rule 24f) |
| `POST /api/billing/systems/panel-groups/:id/members/:panelId/drain` | — | `200` the member, `drain`, with `drainingSince` and `waitSeconds` | 400; 403; 404 `not_found` / `member_not_found`; 409 `already_draining` / `no_other_member` |
| `GET /api/billing/systems/panel-groups/:id/members/:panelId/evict-preview` | — | `{liveConfigs, soleLineGrants}` (rule 24e) | 400; 403; 404 `not_found` / `member_not_found` |
| `POST /api/billing/systems/panel-groups/:id/members/:panelId/evict` | `orphans: 'pause' \| 'refund'`; `.strict()` | `200` the member, `drain`, with `evictedAt`, `evictOrphans`, `evictedBy` and `soleLineGrants` (rule 24e) | 400; 403; 404 `not_found` / `member_not_found` |

## The rules

20. **The platform's groups, and only through the scope.** The group scope is
    `panelScopeOf`'s `tenantId` (null for the owner); a tenant's group is 404
    `not_found`, and a member's panel must be in the panel scope
    (`panel_not_found`). The writes run on `CrossTenantPrismaService`: the
    `tenant_isolation` `WITH CHECK` refuses a null `tenantId` on the app pool.
    Every query carries the scope; `panel_group_member_fits` still holds a
    platform group to platform panels. Tenant groups open in that one scope.
21. **Every group is `mirror`.** No route sets `strategy`, and a body naming it
    is refused (`.strict()`): the others have no fulfilment (groups rule 7).
22. **A change reaches what is placed next.** Fulfilment reads the group on
    its next tick: a new member is placed for Grants already sold, and configs
    already placed keep theirs (groups rule 9). A group names no protocol: its
    panels' picked inbounds do (rule 25).
23. **A member with a live config is drained, not removed.** The `DELETE`
    holds the drain sweep's own condition — no unretired config of the group's
    Grants on the panel — so a removal cannot leave configs outside every
    drain; one it does not remove is 409 `member_has_configs`.
24. **Draining is `role = drain`, once.** Conditional on not `drain`; a second
    is 409 `already_draining`, and the database's clock is never restarted
    (groups rule 14). `waitSeconds` is `2 × subscriptionTtlSeconds`, the least
    the sweep waits from `drainingSince`; the member row goes on its own. The
    group's **last** member that is not `drain` is 409 `no_other_member`
    (F-027-ee): no panel could take its users, so the sweep would hold every
    active Grant on it for good — add a panel first, or evict it (24e).
24a. **A group goes only empty and unsold** (F-027-ca). Members are 409
    `group_has_members` (remove or drain them); a variant naming it is 409
    `group_in_use` — the FK is `RESTRICT`, and the delete meets both keys.

24b. **A member's selling settings override its panel's** (F-027-cg). Resolved
    member -> panel -> platform default, each read naming the layer (network
    `contract.inbounds.md` rule 4a). `selling-settings.spec.ts` pins it.

24c. **An inbound is sold by every group or by the groups it lists** (F-027-ep, ADR-0127): the
    member `PUT` sets its whole set of listings, the `audience` `PUT` one inbound's sellers; a
    group losing an inbound under its live configs is 409 — network `contract.inbounds.md` rule 3a.
    `InboundAudienceController`, beside `SystemsController`. `member-inbounds.spec.ts` pins it.

24d. **A held drain says so.** A `drain` member answers `heldGrants`: its
    active Grants with a line on it and none served elsewhere (groups rule 14,
    `drainConfigs` + `soleLineGrants` in `traffic/group-drain.ts` — the
    sweep's own reading). Null on any other member.

24e. **Evict is "remove now", for a panel broken or gone** (F-027-ee, groups
    rule 16). Any member, the last and a draining one included: it is set
    `drain` with `evictedAt`, and the route retires nothing — the drain sweep
    does, on its next tick, with no wait and no hold, then removes the member.
    The `soleLineGrants` (24d's count, on any member) are settled as the
    required `orphans` says (F-027-eg, user 2026-10-06): `pause` or `refund`
    (network groups rule 16). `evict-preview` answers that count and
    `liveConfigs` first, and the page asks the choice beside it. A second
    evict keeps the first `evictedAt` and choice; `evictedBy` is the owner,
    the actor of a refund's `grant_deletion`.

24f. **A group's share of an inbound is its listing's** (F-027-eq, ADR-0127 decision 3). The
    share `PUT` sets one listing's `maxClients` under the panel's fulfilment lock; only a listing
    has one (`listing_not_found` on an `every_group` inbound or another group's), and the member
    `PUT` keeps it while the listing stays. It, and a member-layer `maxClients`, count the group's
    own Grants; the inbound's and the panel layer's stay physical — network `contract.inbounds.md`
    rule 5. On `InboundAudienceController`. `member-inbounds.spec.ts` pins it.

24g. **Releasing an inbound is a job, the admin's choice** (F-027-es, ADR-0127 decision 6). The
    answer to `inbound_has_configs`, whose `groups` names each group losing it: `move` (each
    config to its group's next placement) or `empty` (retired there; a Grant left with no line
    `pause` or `refund`). A kind of the reseller's config move job — its drain, outcomes and
    progress event (network [contract.config-move.md](../network/contract.config-move.md)). The
    listing changes when the job ends; a cancel leaves it. The job is the actor's tenant's
    (`InboundReleaseService`, on `InboundAudienceController`); `inbound-release.spec.ts` pins it.

`panel-groups.spec.ts` pins rules 20–24e; `member-inbounds.spec.ts` 24c and 24f.
