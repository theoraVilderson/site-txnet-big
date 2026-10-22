---
id: entitlement
layer: domain
status: active
version: 40
updated: 2026-10-22
---

# Contract — entitlement / one user's import from an old subscription link (F-201-g)

A topic file of `contract.md` (§10). A user leaving another seller brings
what is left of their old service with them (D-63): one old subscription
link, read once, becomes one Grant. It runs **on the whole-panel engine**
([contract.import.md](contract.import.md)) — the same `migration_run`, dry
run, commit, rollback and snapshot purge — and this file says only where a
`link` run differs. The request a user hands in and the admin's queue are
F-201-h (panel `contract.migration.md`).

Code: `billing-service/src/app/entitlement/migration-link.ts` (pure: the key,
the client, the correction, the plan), `migration-link-run.ts`
(`MigrationLinkService`, `linkPlanOf`, `readLinkRun`); the link is read
through `SubscriptionLinkProbe.read` (`migration-seams.ts`).

## Rules

1. **A link run names its person and only one.** `kind = link`,
   `sourceAddress` the whole old link (its path is the token the read needs
   and the old link that keeps answering), `userId` an existing person of the
   tenant (`migration_run_link_names_its_person`); `sourceFamily` null. The
   person is found, never made: identity is not asked (identity
   `contract.import.md` is the panel run's), there is no room to forecast,
   and a rollback never removes them.
2. **Read once, no login.** Created in `previewing`; the worker's tick reads
   the link through network's `POST /api/internal/source/link` — from outside,
   no redirect (network `contract.source.md`) — and writes a one-item report.
   A refusal returns the run to `draft` with network's reason, or
   `source_unavailable` / `source_unreadable`. Previewing again reads again
   and clears the corrections (rule 5).
3. **What the link says** (`linkClientOf`): `Subscription-Userinfo` —
   `total` the quota (0 is unlimited, as in every family), `upload` +
   `download` the usage, `expire` the end (0 is none: the product's period at
   the commit, `contract.import.md` rule 18); the protocol of the first line
   we sell (`ss`, `hy2`, `wg` read as theirs), else `unknown_protocol`. **The
   lines are not kept** — they are someone's configs; the commit places fresh
   ones by the product's group.
4. **One key per link** (invariant 32): `link|<origin>|<sha256 of path and
   query>` (`linkIdentityOf`), the trailing slash ignored. The same link
   handed in again plans an `update` and issues nothing; the hash keeps the
   old token out of every Grant and log that carries the key.
5. **The admin's word sits beside the link's, never over it.**
   `correctedDataLimitBytes`, `correctedUsedBytes`, `correctedExpiresAt` on
   the item; null keeps the read figure. The snapshot stays what the link
   claimed. A corrected usage is one figure. The plan and the commit go by the
   corrected client (`linkItemClientOf`).
6. **A product, chosen by the admin** (`migration_run.variantId`): held to
   `contract.import.md` rule 10 (prepaid, assignable, deliverable — the
   reseller's own or one its package lists). A link run has no inbounds.
7. **What the report plans** (`planLinkRun`), in order: `expired` /
   `unknown_protocol` (the client alone); `update` (the tenant holds a Grant
   of the key); `duplicate` (the link's old path already answers for another
   Grant — a panel import brought this client, F-203-a); `traffic_mismatch`
   (an unlimited claim on a limited product or the reverse, once a product is
   chosen); else `create` — before a product too, the commit waiting for one.
8. **Re-planned at once on a correction.** `PUT …/link` on a `previewed`
   run re-plans the one item and the run's counts in the same transaction; the
   link is not read again. The page hears it (`contract.import.md` rule 13).
9. **The commit** is the engine's (`contract.import.md` rules 16–21) with
   the run's person and product: one Grant, `source = migration`, the
   corrected end, bag and usage; the old link recorded (rule 29) so it keeps
   answering once its host points here. Committed with no product is
   `variant_unchosen`. A link run has no source login to destroy.

## Routes

Under `/api/billing/tenants/:tenantId/migration-runs`, the import's door
(`migration.manage`, `staffWrite`); every other route is the engine's.

| Route | Body | Answers |
|---|---|---|
| `POST` | `url` (absolute http(s) with a path, ≤ 2048), `userId` | 201 the run, `previewing` |
| `PUT /:runId/link` | any of `variantId`, `dataLimitBytes`, `usedBytes` (whole, ≥ 0), `expiresAt` (RFC 3339) — left out keeps, null clears | the run, re-planned |

A run's view gains `userId`, `variantId`; a report row gains `corrected`
(`dataLimitBytes`, `usedBytes`, `expiresAt`, each null when not corrected).

| Refusal | Status | Meaning |
|---|---|---|
| `user_not_found` | 404 | the person is not this tenant's |
| `run_not_found` | 404 | not this tenant's link run |
| `run_busy` / `run_closed` | 409 | a correction while the link is read, or once the run left `previewed` |
| `variant_unchosen` | 409 | a commit before a product is chosen |
| `variant_*` | 404 / 422 | `contract.import.md` rule 10 |
