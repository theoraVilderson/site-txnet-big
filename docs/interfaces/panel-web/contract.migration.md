---
id: panel-web
layer: interface
status: active
version: 43
updated: 2026-10-21
---

# Contract — panel-web: a reseller's import from another panel (F-201-f)

A topic file of [contract.md](contract.md) (§10), and a screen of the reseller
workspace described in [contract.resellers.md](contract.resellers.md) "A
reseller's workspace" (ADR-0064 (4)) — its rules 18 and 25 hold here too. A
reseller leaving another panel brings its users with it (D-63).

| page | route | files |
|---|---|---|
| the import | `/my-resellers/[id]/migration`, `/reseller/migration` (`myResellerMigrationPath`); `?run=` opens one run | `my-resellers/[id]/migration/_components/MigrationView.tsx` (history, new), `MigrationRunCard.tsx` (one run), `SourceLoginForm.tsx`, `InboundMapping.tsx`, `MigrationReport.tsx`; rules `my-resellers/_lib/migration.ts` |

Its calls are `migrationRunsApi(tenantId)` (`lib/billing/migration-runs.ts`):
billing's `/tenants/:id/migration-runs` routes and tenant-service's
`PUT …/source-login`. Every rule behind them is entitlement's
[contract.import.md](../../domains/entitlement/contract.import.md) and tenant's
[contract.source-login.md](../../domains/tenant/contract.source-login.md); the
page decides nothing they decide. The menu row is keyed `migration.manage`.

## Rules

1. **One step per state** (`stageOf`): a draft with inbounds read and nothing
   wrong but the mapping (`inbounds_unmapped`) is the mapping; any other draft
   asks for the login — a new run, a login the source refused, or one past its
   7 days unused (tenant rule 4). `previewing` reads, `previewed` is the report
   and the confirm, `committing` the progress, `committed` the result and the
   rollback, `rolling_back` its progress; the rest are closed.
2. **The preview is the connection's test.** "Read my panel" creates the run
   (once — a retry after a later step failed reuses it), stores the login and
   asks for the preview; a refusal comes back as the run's `failureReason`,
   said in a sentence (`failure.*`, an unknown reason as its code).
3. **The address goes whole to the vault, its origin to billing.** The web path
   is a secret (tenant rule 1). A login stored again for a run must be that
   run's origin (`addressOther`): the origin is half of every client's key
   (`remoteIdentityOf`). The login is the register form's, composed as the
   opener reads it (`composeLogin`); Hiddify's is its API key. Never read back.
4. **Families**: the ones network reads (`source.IsFamily`) less legacy x-ui
   (vaxilu), which has no reader yet and could only fail (`no_driver`).
5. **An inbound maps to a prepaid plan only** (entitlement rules 7 and 10): the
   active prepaid plans of active products from the users-admin door's
   catalog (`users-catalog`, its `billingMode`) — no `catalog.manage`. An
   inbound with users offers no "none"; billing would send it back unmapped.
   Saving a draft's mapping previews it; a previewed run's is previewed again
   by billing.
6. **The report is billing's table**, paged, "everyone" or problems only; the
   result column appears from the commit on. Reasons are sentences
   (`skip.*`, `itemFailure.*`, `kept.*`), an unknown one its code. Purged
   snapshots (rule 28) are said, never shown as blanks without why.
7. **Confirm, undo, cancel are each one `useConfirm`**: the commit names the
   count it issues (create + update; none, no button); the rollback shows its
   whole days left, a part day counted whole, and only while `committed`
   before `rollbackUntil`; cancel while `draft` … `previewed`.
8. **Live, never polled** (C-14, RT-1-a): `entitlement.migration_run.progress`
   on the viewer's `user:` channel, and on the reseller's `tenant:` channel when
   it is the session's (a seat hears runs another admin started) — each
   narrowed to this reseller, the card to its run (`migrationLiveOf`). The
   owner on the platform's panel hears only the runs they started; another
   run's card is current on each open.

**Not covered:** link and CSV imports (F-203, F-209); legacy link adoption.
Platform products a reseller's package lists are not offered in the mapping
until the users-admin catalog lists them (it reads the tenant's own products).
