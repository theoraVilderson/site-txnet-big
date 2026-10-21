---
id: entitlement
layer: domain
status: active
version: 36
updated: 2026-10-21
---

# Contract — entitlement / an import from another panel: one client (F-202), the dry run (F-206), the commit (F-207), its usage (F-208)

A topic file of `contract.md` (§10). A reseller leaving another panel brings
its users with it (D-63). `network-service` reads the old panel and answers
each client normalised ([../network/contract.source.md](../network/contract.source.md),
F-201-b); this file says what one such client becomes here. The run and its
items are [data-model.md](data-model.md)'s `migration_run` / `migration_item`
(F-201-a); the people are identity's
([../identity/contract.import.md](../identity/contract.import.md), F-201-e).

Code: `billing-service/src/app/entitlement/migration-plan.ts` —
`sourceClientSchema`, `remoteIdentityOf`, `planMigrationItem`. Pure: no
read, no write. Its caller is the dry run (F-206, below); the commit (F-207)
issues what it planned.

## Rules

1. **The client is parsed, never trusted** (catalog §16). `sourceClientSchema`
   is the snapshot's client shape with bounds: ids and labels ≤ 200
   characters, at most 64 lines a client, byte counts whole and never
   negative, an end that is an RFC 3339 time with its offset or null. A client
   that fails it is the caller's to report; nothing here guesses.
2. **One key per source client: `remoteIdentityOf`** =
   `<family>|<sourceAddress>|<remoteId>` — the run's `sourceFamily`, its
   `sourceAddress` (the origin read) and the client's id there (Marzban's
   username, 3x-ui's email, S-UI's name). The same on every run of that
   panel, so a second run updates instead of issuing again (invariant 32);
   apart from another panel's client of the same name. A panel moved to a new
   address is a new source. The Grant, the `migration_item` and the user
   (identity's `user.remoteIdentity`) carry this one string.
3. **What is planned.** A user named from the label (the remote id when the
   label is blank); a Grant with `source = migration`, from the plan's moment
   to the client's end (none = no end), its quota as the bag
   (`purchasedBytes`) and upload plus download as `consumedBytes` — and as Used's
   start (rule 18); a config of
   the client's protocol from the variant the reseller chose for its inbound,
   placed by that variant's group as any Grant of it (F-027-bl), the client's
   uuid kept for the report (null where the list did not read it, as S-UI's
   from v1.1).
4. **0 is unlimited**, as in every family: the plan is `trafficUnlimited` with
   a bag of 0 (`grant_traffic_unlimited_is_prepaid`). Whether the target
   product sells unlimited is the dry run's (rule 11), not this mapping's.
5. **The source's on/off is kept apart** (`enabled`). A client disabled there
   is not a suspended Grant here: `suspendedAt` starts a purge clock, and an
   import never starts one.
6. **What the client alone says is skipped here**: an end at or before the
   plan's moment is `expired`; a protocol that is not a `ConfigProtocol`
   (trimmed, lower-cased — `naive`, `shadowtls`, `socks`) is
   `unknown_protocol`. A client already imported (`update`), a duplicate and
   the reseller's cap (`over_cap`) need the run and the tenant: they are the
   dry run's (F-206).
7. **An inbound maps to a product, not a server** (user, 2026-10-21). The
   caller passes the prepaid variant chosen for the client's inbound; an
   imported Grant is then a Grant of that variant — it renews and tops up at
   the reseller's price (F-305) and is placed by its group. A server alone
   would have left a Grant with no price to renew at.

## The dry run (F-206)

Code: `migration-run.ts` (the routes' service), `migration-preview.ts` (the
worker's read), `migration-run-plan.ts` (`planRun`, pure),
`migration-seams.ts` (network's snapshot, tenant's vault). Worker job
`migration_run_drain`.

8. **Nothing outside the run's tables before the commit** (invariant 32):
   the dry run writes `migration_run`, `migration_inbound`, `migration_item`
   and the page's event; it reads Grants and people, never writes them.
9. **The flow.** Create (`draft`) → store the source login (tenant
   `contract.source-login.md`) → preview. The worker leases one `previewing`
   run (10 minutes), reads network's snapshot — the bulk calls only — and
   records the source's inbounds with their client counts. An inbound with
   clients and no variant sends the run back to `draft` with
   `failureReason = inbounds_unmapped`: the first preview is how the reseller
   learns what to map. A refusal of the source goes back the same way with
   network's reason (`source_login_refused`, `address_refused`, …;
   `source_unavailable` when network could not be asked).
10. **The mapping** is one prepaid variant per inbound, held to what an admin
    may hand out by hand (F-311-o): the reseller's own product or a platform
    one its package lists, live, deliverable. A metered variant is
    `variant_not_prepaid`: an import brings a bag and an end, not a meter. It
    changes in `draft` or `previewed`; on a previewed run it previews again.
11. **What the report plans** (`planRun`), per client, in the snapshot's
    order: `unreadable` (fails rule 1; its item keeps the id alone — one with
    no id has no item and is only counted), `expired` / `unknown_protocol`
    (rule 6), `traffic_mismatch` (an unlimited client on an inbound mapped to
    a limited variant or the reverse, F-208: mapped again or left), `duplicate` (the same uuid as a client already planned: one
    person on two inbounds), `update` (the tenant holds a Grant of the key),
    `over_cap` (a new person past `end_users_max`; one already imported takes
    no room — the commit asks identity again, this is the forecast), else
    `create`. A client listed twice is planned once.
12. **All or nothing.** The report replaces the last one in one transaction,
    only while the run is still the tick's (`previewing`, its lease): a run
    cancelled or re-previewed meanwhile is left as the reseller left it.
13. **Every move is told** (C-14): `entitlement.migration_run.progress`
    `{tenantId, userId, runId}` to the tenant's channel and the starter's.
14. **Cancel** (`draft`, `previewing`, `previewed`) ends the run and destroys
    its source login (tenant rule 5), best effort: a later read of a closed
    run destroys it anyway.
15. **Links are not read here.** Network's link batch (its rule 4) serves the
    legacy path (F-203-a); the commit places fresh configs, so the dry run
    needs the snapshot alone.

## The commit (F-207)

Code: `migration-commit.ts` (`MigrationCommitService`), the import shape in
`migration-plan.ts` (`importedGrantShape`), `GrantService.issue`'s
`imported`; identity's route through `migration-seams.ts` (`ImportedPeople`).

16. **Confirmed once.** `POST …/commit` moves a `previewed` run to
    `committing`; asked again it is answered as it is. From here the source is
    never read again (its login ends: tenant rule 5).
17. **A batch a tick, up to 200 items**, in the report's order. Skips are
    recorded `skipped` as reached. People first: one identity batch (identity
    `contract.import.md`), and who it *made* is written on the item
    (`createdUserId`) before any Grant, so a rollback (F-211) removes only
    them — a person found is not the run's.
18. **One transaction per item.** A Grant of the inbound's variant, `source =
    migration`, `sourceReferenceId` = the item, from now to the client's end
    (the variant's period when the source set none), its bag the client's
    quota and `consumedBytes` its upload plus download (`importedGrantShape`).
    That usage is also `importedUsedBytes` (F-208): Used is it plus the
    configs' counters (network `contract.lease.md`, billing's `usedBytesOf`),
    so the panels serve the quota less it, and a renewal, reset or gift counts
    it. No ledger entry, no hold: it was served and paid for at the source;
    the rest — features, quotas, group, billing mode — the variant's. It is
    placed at once by its group (`GroupFulfilmentService.fulfil`; a member that
    cannot take it yet is the sweep's), and its configs are recorded on the
    item. A client the source had switched off is frozen `hard` with its clock
    running, as it ran there (rule 5: never a purge clock).
19. **A re-run never duplicates** (invariant 32). A key the tenant already
    holds a Grant of is `updated` and that Grant is **kept as it is**: it has
    lived here since (usage, renewals, money), so a later change at the source
    is not carried over. A crashed item retried finds its Grant by its
    `sourceReferenceId`.
20. **A failed item never blocks the batch.** Its reason is kept: identity's
    (`over_cap`, `deleted`), the sale's (`wholesale_unfunded`,
    `variant_not_assignable`, …), `import_traffic_mismatch` (the variant's
    traffic changed since the dry run planned it, rule 11), `inbound_unmapped`, `expired` (its end came since the preview), or
    `unexpected` (logged). Identity unreachable writes nothing; the next tick
    retries.
21. **The end.** Nothing pending: `committed`, `rollbackUntil` = 7 days on
    (D-63), the source login destroyed. Each batch and the end write the
    page's event (rule 13).

## Routes

Under `/api/billing/tenants/:tenantId/migration-runs`, `ResellerAccess` on
`migration.manage` — `staffWrite` to change, `read` to look.

| Route | Body | Answers |
|---|---|---|
| `POST` | `family` (a `DriverType`), `sourceAddress` (absolute http(s), kept as its origin) | 201 the run, `draft` |
| `GET` | `page`, `pageSize` | the runs, newest first |
| `GET /:runId` | — | the run: status, `failureReason`, counts, `inbounds[]` (`inboundRemoteId`, `tag`, `protocol`, `clientCount`, `variantId`) |
| `PUT /:runId/inbounds` | `inbounds[]` (1..200): `inboundRemoteId`, `variantId` or null | the run |
| `POST /:runId/preview` | — | 202 the run, `previewing` (answered as it is while it runs) |
| `POST /:runId/commit` | — | 202 the run, `committing` (answered as it is once started) |
| `GET /:runId/outcomes` | `page`, `pageSize`, `problems` (skipped and failed only) | the per-user table: `remoteIdentity`, `label`, `inboundRemoteId`, `protocol`, `enabled`, `dataLimitBytes`, `usedBytes`, `expiresAt`, `plannedAction`, `skipReason`, `outcome`, `failureReason` |
| `POST /:runId/cancel` | — | the run, `cancelled` |

`POST /api/internal/billing/migration-runs/drain` (service-only) answers
`{previewed, returned, committed, finished}` for one tick: one dry run, one
commit batch.

| Refusal | Status | Meaning |
|---|---|---|
| `run_not_found`, `inbound_not_found`, `variant_not_found` | 404 | not this reseller's, not in the snapshot, or not a variant it sells |
| `run_busy` | 409 | the run is being previewed |
| `run_closed` | 409 | committing, committed, rolled back, cancelled or expired |
| `run_not_previewed` | 409 | a commit of a run with no report yet (`draft`, `previewing`) |
| `variant_not_prepaid`, `variant_not_assignable`, `variant_not_deliverable` | 422 | rule 10 |

The door's own refusals are every reseller route's (`not_allowed`,
`reseller_suspended`, …).
