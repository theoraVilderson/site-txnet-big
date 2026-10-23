---
id: entitlement
layer: domain
status: active
version: 42
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
6. **Its commit is refused until the adoption exists**: `POST …/commit` on a
   run with a `sourcePanelId` is `in_place_commit_not_built` (409). The
   commit of rule 16 would place every user by the product's group — a new
   login each, the thing this import exists to avoid (ADR-0160 decision 6).

## Decided, not built yet

- **F-1601-b2** (network): the router's user is adopted — our chain attached,
  its own profiles detached, its password never written. Waits for a real
  RouterOS (F-1601-e): whether `transfer-limit` counts the user's lifetime
  total or its profile decides the first ceiling (ADR-0160 decision 9).
- **F-1601-b3**: the commit issues each Grant with no panel group, its config
  that same user; a rollback hands the user back with its own profile; a
  normal end deletes it, as every config of ours (ADR-0160 decisions 6-8).

## Refusals

| Reason | Status | Meaning |
|---|---|---|
| `panel_not_found` | 404 | not the tenant's accepted, live panel of the run's family |
| `panel_required` | 422 | a family imported in place named by an address |
| `family_not_in_place` | 422 | a panel named for a family read through a source login |
| `in_place_commit_not_built` | 409 | rule 6 |
