---
id: panel-web
layer: interface
status: active
version: 43
updated: 2026-10-22
---

# Contract — panel-web: a reseller's import from another panel (F-201-f), one user's from an old link (F-201-h-1), its old address (F-204-b)

A topic file of [contract.md](contract.md) (§10), and a screen of the reseller
workspace described in [contract.resellers.md](contract.resellers.md) "A
reseller's workspace" (ADR-0064 (4)) — its rules 18 and 25 hold here too. A
reseller leaving another panel brings its users with it (D-63).

| page | route | files |
|---|---|---|
| the import | `/my-resellers/[id]/migration`, `/reseller/migration` (`myResellerMigrationPath`); `?run=` opens one run | `my-resellers/[id]/migration/_components/MigrationView.tsx` (history, new), `MigrationRunCard.tsx` (one run), `SourceLoginForm.tsx`, `InboundMapping.tsx`, `MigrationReport.tsx`, `LegacyHostStep.tsx` (the old address), `LinkImportForm.tsx` + `LinkReview.tsx` (one user from a link), `_hooks/usePrepaidPlans.ts`; rules `my-resellers/_lib/migration.ts`, `migration-link.ts` |

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

9. **The old address is the last step** (F-204-b), on a `committed` run:
   every old host billing lists (entitlement
   [contract.legacy-host.md](../../domains/entitlement/contract.legacy-host.md))
   at its step (`legacyStepOf`). No domain: "add this address" adds it as
   `legacy_sub`. The same name with another purpose is said, never re-added —
   it serves no old link. A `legacy_sub` domain is the domains page's card
   (`DomainCard`: TXT, CNAME, check now), read and followed live through the
   same hook (`useResellerDomains`, EDGE-1-f). Only once it is live (verified,
   edge `issued`) is the test offered; its result is a sentence
   (`legacy.failure.*`, an unknown reason as its code), the server count on
   success, a warning for none. A Hiddify run says its own paths do not
   answer yet (F-204-c).

10. **One user from an old link** (F-201-h-1; entitlement
    [contract.link-import.md](../../domains/entitlement/contract.link-import.md)):
    a second start beside the panel's — the link (`linkUrlError`: absolute
    http(s) with a path, billing's `oldLinkSchema`) and a user of the
    reseller, found through its users list (`UserSearch`, `via="reseller"`).
    The run is named by its host alone (`runTitleOf`): the path is its
    owner's token and is never shown. A draft the read sent back is `retry`
    (read again), never the login form; the reasons are the link's own words
    (`link.failure.*`) where they differ.
11. **The review** (`LinkReview`, `previewed`): each figure the link said
    under the field that corrects it; the form starts from the admin's
    correction, else the link's (`linkFormOf`); a save sends only what moved,
    a figure put back to the link's clears the correction
    (`linkCorrectionBody`). The plan offered is a prepaid one (rule 5,
    `usePrepaidPlans`). What the commit will do is billing's plan, said:
    create, nothing (already here), or the skip — a link's `duplicate` is a
    panel import that brought it. The commit is offered once a plan is saved
    (`variant_unchosen`); the result, rollback and old address are the
    panel run's (rules 7, 9).

**Not covered:** a user handing in their own link, its queue and notice (not
built, user 2026-10-22); CSV imports (F-209).
Platform products a reseller's package lists are not offered in the mapping
until the users-admin catalog lists them (it reads the tenant's own products).
