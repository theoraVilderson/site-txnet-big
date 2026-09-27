---
id: billing
layer: domain
status: active
version: 48
updated: 2026-09-26
---

# Systems — the platform owner's panel routes

A topic file of `contract.md` (§10). What governs
`billing-service/src/app/systems/`: the routes behind the systems page
(F-027-ad). The *why* is **ADR-0080**; what `network-service` does with a
registered panel is `network/contract.registration.md`.

Nothing here calls `network-service`. Every route writes desired state or
reads observations in the database (ADR-0071: the Go service has no route);
a hold's release goes to `metering-service` through the outbox.

## Who may call

| Door | Boundary |
|---|---|
| `PanelPermissionGuard`: `panel.manage` (migration `20260924000100`; granted to no role, so SuperAdmin via `*`) | `panelScopeOf` (`panel-scope.ts`): the caller's tenant is `platform_owner`, else 403 `not_platform_owner` |

Every route opens with `panelScopeOf`, which answers the `where` of every read
and the ownership of every write: for the owner, the **platform's** panels
(`ownershipType = platform`, `tenantId` null), not a reseller's dedicated one.
Opening the page to a reseller is a change to that one function, not to a
route (ADR-0080 decision 2). **Registering** stays owner-only: the collector
would dial an address a tenant chose (`network/open-questions.md`).

## Routes

| Route | Body | Answers | Errors |
|---|---|---|---|
| `POST /api/billing/systems/panels` | `name`, `ipAddress` (required for `push`, its NAS's allowlist entry; optional for `pull`, F-027-br, CHECK `panel_push_has_ip_address`), `apiBaseUrl` (required for `pull`), `clientBaseUrl?` (where users are served their links, F-027-bg; refused for `push`), `driverType`, `counterSemantics`, `transport`, `role`, `region`, `maxRequestsPerMinute?`, `credentials` (≤4096), `radiusSecret` (≤4096; required for `push`, refused for `pull`); `.strict()` | `201 {id, reviewState: 'pending', credentials: {configured, version, rotatedAt}, radiusSecret?}` (`radiusSecret` on a push panel, same three fields) | 400 validation; 403 `panel.manage` / `not_platform_owner`; 409 `panel_already_registered` + `facts.panelId` when in scope (rule 4a); 400/403/404 relayed from the vault seam; 502 `credentials_unavailable` |
| `PUT /api/billing/systems/panels/:id/credentials` | `credentials` (1–4096, untrimmed); `.strict()` | `200 {id, reviewState, retest, credentials: {configured, version, rotatedAt}}` | 400; 403; 404 `not_found`; 409 `panel_refused`; 400/403/404 relayed from the vault seam; 502 `credentials_unavailable` |
| `PUT /api/billing/systems/panels/:id/radius-secret` | `radiusSecret` (1–4096, untrimmed); `.strict()` | `200 {id, reviewState, radiusSecret: {configured, version, rotatedAt}}` | 400; 403; 404 `not_found`; 409 `panel_not_push` / `panel_refused`; 400/403/404 relayed from the vault seam; 502 `credentials_unavailable` |
| `GET /api/billing/systems/panels` | — | `[{id, name, driverType, transport, role, region, ipAddress, apiBaseUrl, clientBaseUrl, retiredAt, radiusSecretConfigured, review: {reviewState, connectionTestedAt, connectionTestFault, connectionTestDetail, duplicateOf: {id, name} | null}, health: {panelState, lastHealthyAt, lastSuccessfulCollectionAt, collectionHalted, openDriftEvents}, budget: {maxRequestsPerMinute, blockedSince}}]`, by name | 403 |
| `PATCH /api/billing/systems/panels/:id`, `DELETE …/panels/:id`, `POST …/panels/:id/restore` | edit, delete or archive, restore — [contract.panel-lifecycle.md](contract.panel-lifecycle.md) | | |
| `GET /api/billing/systems/panels/:id/capabilities` | — | `{id, transport, reviewState, connectionTestedAt, documentVersion, current, answeredAt, rows: [{key, scope, severity, state, detail}]}` | 400 id not a uuid; 403; 404 `not_found` |
| `GET /api/billing/systems/drift-events` | query `state?` (`open` \| `all`, default `all`), `after?` (event id), `limit?` (1–100, default 50); `.strict()` | `{items: [{id, panelId, panelName, eventType, foreignPanel: {id, name} \| null, affectedConfigCount, observedConfigCount, detectedAt, collectionHalted, acknowledgedAt, acknowledgedByAdminId, note}], next}`, newest first; `next` is the `after` of the following page, null on the last | 400; 403 |
| `POST /api/billing/systems/drift-events/:id/acknowledge` | `note?` (1–1000); `.strict()` | `200` the event, acknowledged | 400; 403; 404 `not_found`; 409 `already_acknowledged` |
| `GET /api/billing/systems/holds` | query `state?` (`pending` \| `all`, default `all`), `after?` (hold id), `limit?` (1–100, default 50); `.strict()` | `{items: [{id, configId, panelId, panelName, upBytes, downBytes, reason, state, heldFrom, heldAt, resolvedAt, resolvedByAdminId, resolutionNote}], next}`, newest first; bytes are decimal strings | 400; 403 |
| `POST /api/billing/systems/holds/:id/release` | `note?` (1–1000); `.strict()` | `202 {id, state: 'pending', release: 'queued'}` | 400; 403; 404 `not_found`; 409 `already_resolved` |
| `POST /api/billing/systems/holds/:id/write-off` | `note` (1–1000, required); `.strict()` | `200` the hold, `written_off` | 400; 403; 404 `not_found`; 409 `already_resolved` |
| `GET /api/billing/systems/panel-groups` | — | `[{id, name, strategy, minHealthyPanels, subscriptionTtlSeconds, createdAt, updatedAt, variantCount, members: [{groupId, panelId, panelName, panelState, reviewState, lastHealthyAt, inboundPlacement, maxClients, priority, weight, inboundsPerBuyer, effective, inbounds, role, drainingSince, createdAt}]}]`, by name; members by effective `priority`. The five are the member's own (null = inherited); `inbounds` its assigned remote ids, `[]` = the pool (rule 24c); `effective` is `{<setting>: {value, layer}}`, layer `member` \| `panel` \| `platform` (rule 24b) | 403 |
| `POST /api/billing/systems/panel-groups` | `name`, `minHealthyPanels?` (1–100), `subscriptionTtlSeconds?` (60–604800); `.strict()` — `protocol` is refused since F-114-b | `201` the group, `strategy: mirror` | 400; 403 |
| `PATCH /api/billing/systems/panel-groups/:id` | any of the three, at least one; `.strict()` | `200` the group | 400; 403; 404 `not_found` |
| `DELETE /api/billing/systems/panel-groups/:id` | — | `200 {id, removed: true}` | 400; 403; 404 `not_found`; 409 `group_has_members` / `group_in_use` |
| `POST /api/billing/systems/panel-groups/:id/members` | `panelId`, and any of `inboundPlacement`, `maxClients` (1–1000000), `priority` (0–1000), `weight` (1–1000), `inboundsPerBuyer` (1–16, K under `hrw`), each nullable; `.strict()` | `201` the member, `primary` | 400; 403; 404 `not_found` / `panel_not_found`; 409 `already_member` |
| `PATCH /api/billing/systems/panel-groups/:id/members/:panelId` | any of those four, at least one; null inherits; `.strict()` — a server fact is refused | `200` the member | 400; 403; 404 `not_found` / `member_not_found` |
| `DELETE /api/billing/systems/panel-groups/:id/members/:panelId` | — | `200 {groupId, panelId, removed: true}` | 400; 403; 404 `not_found` / `member_not_found`; 409 `member_has_configs` |
| `PUT /api/billing/systems/panel-groups/:id/members/:panelId/inbounds` | `inbounds: [remoteId]` (≤500, each once; `[]` = the pool again); `.strict()` | `200 {groupId, panelId, inbounds}` | 400; 403; 404 `not_found` / `member_not_found` / `inbound_not_found`; 409 `inbound_not_sellable`, `inbound_assigned_elsewhere` `facts: {remoteId, groupId}` (none after a race on the unique index), `inbound_has_configs` `facts: {remoteId, configs}` |
| `POST /api/billing/systems/panel-groups/:id/members/:panelId/drain` | — | `200` the member, `drain`, with `drainingSince` and `waitSeconds` | 400; 403; 404 `not_found` / `member_not_found`; 409 `already_draining` |
| `GET /api/billing/systems/panels/:id/inbounds` | — | `{panelId, inboundPlacement, maxClients, priority, weight, inboundsPerBuyer, effective, inboundsReadAt, users, inbounds: [{remoteId, tag, protocol, port, host, enabled, goneAt, seenAt, sold, maxClients, assignedTo, clients}]}`, by id; `assignedTo` `{id, name}` of the group holding it, null = the pool (rule 24c) | 400; 403; 404 `panel_not_found` |
| `PUT /api/billing/systems/panels/:id/inbounds` | any of the five selling settings as on a member (null = platform default), `inbounds: [{remoteId, sold, maxClients?}]` (≤500, each once); `.strict()` | `200` as the `GET` | 400; 403; 404 `panel_not_found` / `inbound_not_found`; 409 `inbound_not_sellable` |
| `POST /api/billing/systems/panels/:id/inbounds/refresh` | — | `202 {panelId, refreshRequested: true}` | 400; 403; 404 `panel_not_found` |

Rate limits, per user, per 15 minutes: `SYSTEMS_ADMIN_WRITE` 30 (register,
both re-submits, the panel edit, delete and restore, acknowledge, release, write-off, the eight group writes, the two inbound writes), `SYSTEMS_ADMIN_READ` 120 (the six reads).

## Registering a panel — the rules

1. **A desired-state write, nothing more.** The row lands with
   `reviewState = pending`, `ownershipType = platform`, `tenantId` null
   (network invariant 9). The verdict arrives on `network-service`'s next tick;
   the response never carries one.
2. **The login goes to the vault and nowhere else.** It is relayed to
   `tenant-service`'s `POST /api/internal/vault/panel-credential`
   (`tenant/contract.vault.md`), stored as kind `panel_credentials` under
   `panelCredentialLabel(panelId)` in the **owner's** vault.
   `panel.panelApiCredentials` holds `panelCredentialRef(tenantId, panelId)`
   — `vault:<tenantId>:panel_credentials:panel:<panelId>` — never the login.
   Both spellings are in `shared-core` (`tenant/vault/panel-label.ts`).
3. **No half-registration.** Row first (the seam checks the row exists), vault
   second; a vault that refuses or does not answer deletes the row, so no tick
   tests a panel whose login was never stored. A push panel's RADIUS secret
   is the second vault write, and its failure deletes the row too.
4. **Nothing reads a login back.** The answer is `{configured, version,
   rotatedAt}`, picked field by field from the seam's reply.
4a. **Registered once (F-027-cd, ADR-0090 decision 1).** No two panels, of any
   owner and archived ones included, share a normalised `apiBaseUrl` —
   lower-case, no user info, query or fragment, the default port written out,
   no trailing `/`, the path kept. Another is 409 `panel_already_registered`,
   naming the holder as `facts.panelId` (F-027-ci: the envelope carries only ids, never a name) so
   the owner edits or restores it — only inside the actor's scope; another owner's sends none,
   as is a `review.duplicateOf` or a `foreignPanel` outside it (`inScope`).
   The normaliser is SQL, `network.panel_api_address`; the unique index
   `panel_api_address_key` over it settles a race and billing's look-up uses
   the same function (`systems/panel-address.ts`). Several panels on one host
   differ by port or path and stay allowed. `panel-address.spec.ts` pins it.

`panel-registration.spec.ts` pins rules 1–3, the owner refusal and rules 17–19.

## The reads, and acknowledging drift — the rules

5. **What the loops last wrote, never a call.** Health, budget, review and
   the matrix are `network.panel` columns as `network-service` left them
   (ADR-0071). Staleness shows as a timestamp (`lastSuccessfulCollectionAt`,
   `connectionTestedAt`), never as a figure this service made up.
6. **Field by field.** Every panel read names its columns;
   `panelApiCredentials` is never selected, so no answer can carry the vault
   reference. `panelRadiusSecret` is selected only to answer
   `radiusSecretConfigured` (null on a pull panel); the reference never leaves.
7. **The matrix's vocabulary is `contracts/network/capabilities.json`.**
   `systems/capabilities.ts` mirrors its keys, scopes and severities, held to
   it by `systems-read.spec.ts` as `questionnaire_test.go` holds Go's. Every
   row is answered, in order, as one of: `supported`, `unsupported` (with the
   driver's `detail`), `unanswered` (in scope, no current answer), or
   `not_asked` (outside the panel's transport). A document under another
   `version` is not read: `current: false`, every row in scope is
   `unanswered`, and the next connection test re-answers it. Question text
   is not sent; the page says it in the reader's language, keyed by `key`.
8. **`collectionHalted` is the collector's own test**: an event with
   `collectionHalted` and no `acknowledgedAt` (`collect.Containment.Halted`).
   The page and the loop cannot disagree about a halted panel.
9. **Acknowledging is the decision the halt waits for, once.** It sets
   `acknowledgedAt`, `acknowledgedByAdminId` and the `note`, conditional on
   `acknowledgedAt IS NULL`; the panel is read again on the next pass.
   A second click, even concurrent, is 409 `already_acknowledged`, and who
   decided is never rewritten. An event on a panel outside the scope is 404,
   the same as one that does not exist.
9a. **A `foreign_claim` names the other panel only inside the scope**
   (F-027-cf, `network/contract.drift.md`): `foreignPanel` is the panel whose
   users it answered with, null when unset or outside the reader's panels.
   It stops convergence too, so acknowledging one unfixed only raises it again.

`systems-read.spec.ts` pins rules 6–9a, the scope on every route, and the
fixture.

## The holds queue — the rules

Bytes the meter believed and could not bill (ADR-0074), and the two ways a
person ends one (ADR-0080 decision 3). `usage_hold` has no relation to
`panel`, so the scope is the set of panel ids `panelScopeOf` admits: a hold
outside it is absent from the list and 404 by id.

10. **Release goes through the meter; this service never bills.** The route
    writes an `outbox_event` of type `network.usage.release`
    (`OutboxEventType.USAGE_RELEASE`, aggregate `network.usage_hold`, payload
    `{holdId, adminId, note}`) and answers `202`; the hold stays `pending`.
    The relay publishes it as `outbox.network.usage.release`, and
    `metering-service` flips and bills it ([contract.metering.md](contract.metering.md)).
    The message carries no bytes: the meter reads them from the hold.
11. **A second release is harmless.** Every copy — a second click, a relay
    redelivery — carries the same `usageReleaseDeltaId(holdId)` (a UUIDv5,
    `shared-core` `usage-release.ts`), and the meter absorbs it.
12. **A write-off is never charged, and happens once.** It sets `written_off`,
    `resolvedAt`, `resolvedByAdminId` and the required `note`, conditional on
    `pending`; a second click is 409 `already_resolved` and who decided is
    never rewritten. A release queued before it then finds the hold resolved
    and bills nothing. There is no `dropped` state.
13. **Bytes leave as decimal strings**, as on the wire (`usage-delta.ts`): a
    BIGINT past 2^53 is not a JSON number.

`usage-holds.spec.ts` pins rules 10–13 and the scope on the three routes.

## Re-submitting a login — the rules (F-027-au)

14. **Rotated, never read.** The login goes to the same seam as at
   registration; the vault's `put` is also rotate
   (`tenant/contract.vault.md` rule 3), and the answer is the same three
   fields. The vault answers first: one that fails leaves the row as it was.
15. **Only a `pending` panel is re-tested.** Its `connectionTestedAt`,
   fault and detail are cleared, conditional on `pending`, so the next tick
   tests the new login at once (`network/contract.registration.md` rule 4)
   and a verdict written meanwhile stands. `retest` says whether the clear
   landed. **Except after `rate_limited`**: that fault keeps its time and the
   cool-off runs out as it would have — a new login does not lift a rate limit.
16. **An accepted panel is rotated and nothing else.** Collection reads only
   an accepted panel (network invariant 44); a password change must not stop
   it. A **refused** one is 409 `panel_refused` and nothing is written: it
   was refused on its answers, which a login does not change.

`panel-resubmit.spec.ts` pins rules 14–16, the scope and the schema.

## A push panel's RADIUS secret — the rules (F-027-az)

17. **Its own secret, its own reference.** The NAS signs accounting with a
    shared secret that cannot also be the REST login. It goes to the same
    seam with `secret: 'radius_secret'`, under
    `panelRadiusSecretLabel(panelId)` (`panel:<panelId>:radius`), and
    `panel.panelRadiusSecret` holds `panelRadiusSecretRef`. CHECK
    `panel_radius_secret_is_push_only` refuses it on a pull panel.
18. **Required at registration for push, refused for pull** (the schema). A
    push panel registered before this has none. The panel list says so with
    `radiusSecretConfigured: false`, and the allowlist leaves its NAS off.
19. **Re-submitting it re-tests nothing.** The connection test never reads the
    secret, so the review and the last test are left alone, and the allowlist
    reads the new secret within a minute. On a row with no reference yet, the
    reference is written **after** the vault answered. A pull panel is 409
    `panel_not_push`, a refused one 409 `panel_refused`.

## Panel groups — the rules (F-027-bw)

Where a `network_access` variant's Grants are placed (network
[contract.groups.md](../network/contract.groups.md)). `panel-groups.ts`.

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
    the sweep waits from `drainingSince`; the member row goes on its own.
24a. **A group goes only empty and unsold** (F-027-ca). Members are 409
    `group_has_members` (remove or drain them); a variant naming it is 409
    `group_in_use` — the FK is `RESTRICT`, and the delete meets both keys.

24b. **A member's selling settings override its panel's** (F-027-cg). Resolved
    member -> panel -> platform default, each read naming the layer (network
    `contract.inbounds.md` rule 4a). `selling-settings.spec.ts` pins it.

24c. **An inbound is the pool's or one group's** (F-027-ch, ADR-0090 decision 3): the `PUT` sets a
    member's whole set — network `contract.inbounds.md` rule 3a. `member-inbounds.spec.ts` pins it.

`panel-groups.spec.ts` pins rules 20–24b.

## A panel's inbounds (F-114-b)

`panel-inbounds.ts`; what the pick does is network's
[contract.inbounds.md](../network/contract.inbounds.md).

25. **The read is the panel's, the pick is the admin's.** The `GET` is what
    `network-service` last read, each inbound's live configs and the panel's
    users (the counts fulfilment caps by). The `PUT` writes only `sold`,
    `maxClients` and the panel's `inboundPlacement` / `maxClients`, in one
    transaction; a field left out keeps its value. A pick names an inbound
    the read found (404 `inbound_not_found`), and only a sellable one — not
    gone, of a `ConfigProtocol` — may be sold (409 `inbound_not_sellable`);
    unselling is always allowed. `refresh` clears `inboundsReadAt`, and the
    panel's next pass reads again. On the cross-tenant pool, scoped as rule 20.
    `panel-inbounds.spec.ts` pins it.
