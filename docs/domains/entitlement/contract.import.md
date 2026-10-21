---
id: entitlement
layer: domain
status: active
version: 33
updated: 2026-10-21
---

# Contract — entitlement / what an import issues for one source client (F-202)

A topic file of `contract.md` (§10). A reseller leaving another panel brings
its users with it (D-63). `network-service` reads the old panel and answers
each client normalised ([../network/contract.source.md](../network/contract.source.md),
F-201-b); this file says what one such client becomes here. The run and its
items are [data-model.md](data-model.md)'s `migration_run` / `migration_item`
(F-201-a); the people are identity's
([../identity/contract.import.md](../identity/contract.import.md), F-201-e).

Code: `billing-service/src/app/entitlement/migration-plan.ts` —
`sourceClientSchema`, `remoteIdentityOf`, `planMigrationItem`. Pure: no
read, no write. Its caller is the dry run (F-206); the commit (F-207) issues
what it planned.

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
   (`purchasedBytes`) and upload plus download as `consumedBytes`; a config of
   the client's protocol on the panel the reseller chose for its inbound, with
   the client's uuid (null where the list did not read it, as S-UI's from
   v1.1 — the link batch does).
4. **0 is unlimited**, as in every family: the plan is `trafficUnlimited` with
   a bag of 0 (`grant_traffic_unlimited_is_prepaid`). Whether the target
   product sells unlimited is F-208's question, not this mapping's.
5. **The source's on/off is kept apart** (`enabled`). A client disabled there
   is not a suspended Grant here: `suspendedAt` starts a purge clock, and an
   import never starts one.
6. **What the client alone says is skipped here**: an end at or before the
   plan's moment is `expired`; a protocol that is not a `ConfigProtocol`
   (trimmed, lower-cased — `naive`, `shadowtls`, `socks`) is
   `unknown_protocol`. A client already imported (`update`), a duplicate and
   the reseller's cap (`over_cap`) need the run and the tenant: they are the
   dry run's (F-206).
7. **The panel is given, not looked up.** The caller passes the panel chosen
   for the client's inbound; a run with an inbound not mapped is not
   previewed (F-206, F-201-f).
