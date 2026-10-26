---
id: entitlement
layer: domain
status: active
version: 44
updated: 2026-10-23
---

# Contract — entitlement / an import read in place: a RADIUS router's users keep their login (F-1601)

A topic file of `contract.md` (§10), beside [contract.import.md](contract.import.md),
whose rules hold here unless one below says otherwise. A MikroTik User
Manager's users are RADIUS accounts a NAS dials in with; recreating one
elsewhere is a new username and password on every customer's device. So
such a family is imported **in place** (ADR-0160): the router is the tenant's
registered panel, each user stays on it with its own login, and a move
elsewhere happens only when someone asks (F-1601-d).

Code: `billing-service/src/app/entitlement/migration-run.ts` (`sourceOf`),
`migration-plan.ts` (`isInPlaceFamily`, the one place the family question is
answered — C-18), `migration-run-plan.ts`, `migration-preview.ts`
(`sourceReadOf`); network's read in
[../network/contract.source.md](../network/contract.source.md) rule 10.

## Built so far — the dry run (F-1601-b1)

1. **The run names the router, not an address and a login.** `POST
   …/migration-runs` with `{family, panelId}` for a family imported in place
   (`mikrotik_user_manager` today): the tenant's own panel of that family,
   `accepted` or `accepted_low_trust`, not retired — else `panel_not_found`.
   The router's login is the panel's, already in the vault: no source login
   is stored for the run, and none is destroyed at its cancel. Such a family
   named by `sourceAddress` is `panel_required`; a `panelId` with any other
   family is `family_not_in_place`. `migration_run.sourcePanelId` keeps it
   (CHECK `migration_run_in_place_is_a_panel_run`).
2. **The key is unchanged** (`contract.import.md` rule 2): family, address,
   remote id. The address is the panel's `apiBaseUrl` origin, written on the
   run at its create, so a later run of the same router finds its Grants.
3. **The snapshot is read with the panel's login.** The preview asks network
   with `panelId` instead of `credentialRef`: profiles answered as inbounds,
   users without their passwords (`uuid` empty), each user's end and its
   router's own usage total.
4. **A profile maps to a product**, where an Xray import maps an inbound:
   the same mapping step, routes and checks (`contract.import.md` rule 10).
5. **What the plan does not ask in place.** A user has no protocol of its
   own — its login serves whatever the router's NAS dials in with — so none
   is `unknown_protocol`. A user holding no profile cannot log in there: it
   is skipped `no_inbound`, and counts toward no inbound, so it never holds
   the run in `inbounds_unmapped`. The other skips are rule 11's.

## The commit and the rollback (F-1601-b3)

`migration-commit.ts` (`adopt`), `traffic/config-actions.ts`
(`adoptInPlace`), `migration-rollback.ts` (`close`).

6. **Each user's Grant stays on its router** (ADR-0160 decision 6). The
   commit is rule 18's — people, the Grant from the snapshot, its usage,
   frozen if the router had it off — except the placement: the Grant's
   `panelGroupId` is cleared in the same transaction, so no group places a
   second login for it, and its one config is that same user: the run's
   `sourcePanelId`, the user's name as `remoteId` from the start, its
   profile and label as `adoptedProfile` and `adoptedLabel`, protocol
   `router_login` (a RADIUS login serves whatever the NAS dials; F-1601-d3). The `uuid` minted
   for it is never the router's password.
7. **Network adopts it** (F-1601-b2, network `contract.usermanager.md` rules
   13-14): our chain linked, the user's own profiles off, its password never
   written; the first ceiling is the remaining allocation, since
   `transfer-limit` counts from the link (F-1601-e).
8. **A rollback hands the user back** (decision 7): rule 25's close, and in
   the same transaction each adopted config of the Grant is marked
   `handBack`, so the pass links the user's own profile again, removes ours
   and restores its label — never deleting it. Its on/off is left as the
   router has it. **A normal end deletes it** (decision 8): an admin's
   delete or the purge, as for every config of ours.
9. **Their usage is the router's**: each user's lifetime total, read as a
   `cumulative` counter (network ADR-0161, F-027-ag-b), and the ceiling
   counts from our profile link, so a link made again hands out nothing
   twice (F-027-du-b). Nothing network-side holds the page (F-1601-c) back.

## A reseller's own router (F-1601-g, ADR-0162)

`migration-router.ts`, beside the run's routes on `migration-run.controller.ts`.

10. **The reseller registers the router a run names.** `POST
    …/migration-runs/routers` `{family, name, apiBaseUrl, credentials}`
    (the systems page's field rules, `.strict()`) -> **201** `{id,
    reviewState: 'pending', credentials}`. A family not imported in place
    is `family_not_in_place`: the systems page is the owner's alone. The
    panel is the **path's** tenant's (`ownershipType tenant`), never the
    session's, and its login is sealed under that tenant; the owner in a
    reseller's workspace registers the reseller's router.
11. **The family decides the declaration** (`IN_PLACE_DECLARATION`, with
    `isInPlaceFamily` in `migration-plan.ts`): User Manager is `pull` /
    `cumulative`, role `active`, region `reseller` (no group places a user
    on it). Network then tests it as any panel; a tenant's panel never gets
    the egress allowlist (ADR-0095), so a private address is unreachable.
12. **The list** `GET …/migration-runs/routers` -> `{routers: [{id, name,
    family, address, reviewState, fault, testedAt}]}`: the tenant's own live
    panels of a family imported in place, by name, at most 100. `address` is
    the origin only: a path can be a secret. The verdict reaches the
    reseller's `tenant:` channel (`network.panel.tested`).
13. **A login re-entered** `PUT …/routers/:panelId/credentials`
    `{credentials}`: the systems re-submit (a `pending` panel is tested
    again), on the tenant's own router only, else `panel_not_found`. It is
    read on the cross-tenant pool with the owner in its `where`:
    `tenant_isolation` hides a reseller's panel from a bare app-pool read.

All three routes are `migration.manage`: `staffWrite` to write, `read` to list.

## Refusals

| Reason | Status | Meaning |
|---|---|---|
| `panel_not_found` | 404 | not the tenant's accepted, live panel of the run's family |
| `panel_required` | 422 | a family imported in place named by an address |
| `family_not_in_place` | 422 | a panel named for a family read through a source login |
| `panel_already_registered` | 409 | a router's address is registered already, anyone's (`facts.panelId` only when it is the tenant's) |
| `reseller_limit_reached` | 409 | the reseller's live panels are at its `panels_max` (BYO-1-a, ADR-0166): a router counts as a panel; `facts {key, limit, used}` |
| `panel_refused` | 409 | a login re-entered on a router its test refused |
