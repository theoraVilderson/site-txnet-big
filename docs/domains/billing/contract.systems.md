---
id: billing
layer: domain
status: active
version: 36
updated: 2026-09-24
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
| `POST /api/billing/systems/panels` | `name`, `ipAddress`, `apiBaseUrl` (required for `pull`), `driverType`, `counterSemantics`, `transport`, `role`, `region`, `maxRequestsPerMinute?`, `credentials` (≤4096), `radiusSecret` (≤4096; required for `push`, refused for `pull`); `.strict()` | `201 {id, reviewState: 'pending', credentials: {configured, version, rotatedAt}, radiusSecret?}` (`radiusSecret` on a push panel, same three fields) | 400 validation; 403 `panel.manage` / `not_platform_owner`; 400/403/404 relayed from the vault seam; 502 `credentials_unavailable` |
| `PUT /api/billing/systems/panels/:id/credentials` | `credentials` (1–4096, untrimmed); `.strict()` | `200 {id, reviewState, retest, credentials: {configured, version, rotatedAt}}` | 400; 403; 404 `not_found`; 409 `panel_refused`; 400/403/404 relayed from the vault seam; 502 `credentials_unavailable` |
| `PUT /api/billing/systems/panels/:id/radius-secret` | `radiusSecret` (1–4096, untrimmed); `.strict()` | `200 {id, reviewState, radiusSecret: {configured, version, rotatedAt}}` | 400; 403; 404 `not_found`; 409 `panel_not_push` / `panel_refused`; 400/403/404 relayed from the vault seam; 502 `credentials_unavailable` |
| `GET /api/billing/systems/panels` | — | `[{id, name, driverType, transport, role, region, radiusSecretConfigured, review: {reviewState, connectionTestedAt, connectionTestFault, connectionTestDetail}, health: {panelState, lastHealthyAt, lastSuccessfulCollectionAt, collectionHalted, openDriftEvents}, budget: {maxRequestsPerMinute, blockedSince}}]`, by name | 403 |
| `GET /api/billing/systems/panels/:id/capabilities` | — | `{id, transport, reviewState, connectionTestedAt, documentVersion, current, answeredAt, rows: [{key, scope, severity, state, detail}]}` | 400 id not a uuid; 403; 404 `not_found` |
| `GET /api/billing/systems/drift-events` | query `state?` (`open` \| `all`, default `all`), `after?` (event id), `limit?` (1–100, default 50); `.strict()` | `{items: [{id, panelId, panelName, eventType, affectedConfigCount, observedConfigCount, detectedAt, collectionHalted, acknowledgedAt, acknowledgedByAdminId, note}], next}`, newest first; `next` is the `after` of the following page, null on the last | 400; 403 |
| `POST /api/billing/systems/drift-events/:id/acknowledge` | `note?` (1–1000); `.strict()` | `200` the event, acknowledged | 400; 403; 404 `not_found`; 409 `already_acknowledged` |
| `GET /api/billing/systems/holds` | query `state?` (`pending` \| `all`, default `all`), `after?` (hold id), `limit?` (1–100, default 50); `.strict()` | `{items: [{id, configId, panelId, panelName, upBytes, downBytes, reason, state, heldFrom, heldAt, resolvedAt, resolvedByAdminId, resolutionNote}], next}`, newest first; bytes are decimal strings | 400; 403 |
| `POST /api/billing/systems/holds/:id/release` | `note?` (1–1000); `.strict()` | `202 {id, state: 'pending', release: 'queued'}` | 400; 403; 404 `not_found`; 409 `already_resolved` |
| `POST /api/billing/systems/holds/:id/write-off` | `note` (1–1000, required); `.strict()` | `200` the hold, `written_off` | 400; 403; 404 `not_found`; 409 `already_resolved` |

Rate limits, per user, per 15 minutes: `SYSTEMS_ADMIN_WRITE` 30 (register,
both re-submits, acknowledge, release, write-off), `SYSTEMS_ADMIN_READ` 120 (the four reads).

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

`systems-read.spec.ts` pins rules 6–9, the scope on every route, and the
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
