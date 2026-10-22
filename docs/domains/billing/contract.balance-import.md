---
id: billing
layer: domain
status: active
version: 1
updated: 2026-10-22
---

# Contract — billing / balances brought from an old panel in a file (F-209-a)

A topic file of [contract.md](contract.md) (§10). A reseller leaving another
panel brings its users' wallet balances with it (D-63), one row each in a
file. It runs **on the import engine**
([../entitlement/contract.import.md](../entitlement/contract.import.md)) — the
same `migration_run` (`kind = csv`), confirm, commit, rollback and snapshot
purge — and this file says only where a `csv` run differs. Catalog §16's
hard rule: **a balance is a ledger row, never an UPDATE on a balance.**

Code: `billing-service/src/app/wallet/balance-import.ts` (pure: the file, the
plan; the commit's write), `balance-import-rollback.ts` (the rollback's),
`balance-import-plan.ts` (`balancePlanOf`, `balanceRowsOf`),
`balance-import-run.ts` (`BalanceImportService`); the engine's
`migration-preview.ts`, `migration-commit.ts`, `migration-rollback.ts` call
them for a `csv` run.

## Rules

1. **The file.** A header naming `user`, `amount` and `currency` — any case,
   any order, other columns ignored; optionally `telegram`, the person's
   Telegram account (F-210) — then one row per balance; blank lines
   skipped. Separated by `,`, `;` or a tab (the one that splits the header
   most); double quotes may hold a separator. A record is one line. At most
   `BALANCE_FILE_MAX_CHARS` (90 000 characters, under the 100 KB body) and
   `BALANCE_ROWS_MAX` (5 000) rows; a bigger file is split by the reseller.
2. **A file no row can be read from makes no run**: `csv_columns` (a column
   missing), `csv_empty`, `csv_too_many_rows` — 422, nothing written.
3. **The dry run is made at the create**, in one transaction with the run:
   the file is the whole source, there is nothing to read. The run is answered
   `previewed` with its report; nothing outside the run's tables is written
   (entitlement invariant 32). `POST …/preview` plans the kept rows again — a
   person the reseller has added since is found; the file is not sent again.
4. **Who a row names**: a person of the tenant whose `username`,
   `phoneNumber` (E.164; digits in any script folded) or `remoteIdentity` is
   the `user` cell, exactly; a deleted person is nobody. The item's key is
   `csv|<line, six digits>`, so the report reads in the file's order.
5. **What the report plans**, per row in order: `unreadable` (a blank or
   over-long name, an amount that is not a positive decimal — grouping marks
   and any script's digits folded — or a currency that is not three letters;
   or an amount finer than the wallet's currency, refused, never rounded,
   ADR-0153); `unknown_user`; `ambiguous_user` (one person's username is
   another's phone); `duplicate` (a second row for one person: one balance
   each); `currency_mismatch` (not the person's wallet currency — the tenant's
   operating currency when they have no wallet; never converted); else
   `create`. A `telegram` cell, digits folded, that is not a plain id makes
   the row `unreadable`. A row's cells are kept on its item (`line`, `user`,
   `amount`, `currency`, the `userId` it credits and its `telegramId`). At
   the commit each credited person's id is claimed through identity
   (`/import/telegram`, identity `contract.import.md` rule 9) before the credit,
   its outcome kept as the item's `telegramLink`.
6. **The commit credits one `migration_import` row per planned row**,
   `referenceId` = its `migration_item`, through `WalletCreditService` like
   every user credit (a Grant the money funds is revived with it), in the
   item's transaction with its outcome. A row retried is credited once: the
   item's guard, and a unique index on `(referenceId, direction)` for the
   reason. A person deleted since the dry run fails the item `user_not_found`;
   identity is never asked and no person is made, so a rollback never removes
   one.
7. **The rollback writes the reversing debit** — the same reason, amount and
   currency as the credit, naming the same item. A wallet that moved since the
   credit by any other reason (spent, topped up, a currency change), or whose
   free balance cannot cover it (a hold), is `kept` with `wallet_used`: the
   money is the customer's now, as a renewed Grant is (entitlement rule 24).
8. **Not a sale, not money paid in.** `migration_import` counts in no revenue
   (`IS_SALE` false, no product) and is not a payment the rollback's `bought`
   reads. The user's ledger page shows it unnarrowed ("balance brought from
   the previous panel", `contract.history.md`).

## Routes

The engine's, under `/api/billing/tenants/:tenantId/migration-runs`
(`migration.manage`, `staffWrite` to change).

| Route | Body | Answers |
|---|---|---|
| `POST` | `csv` — the file's text, 1..90 000 characters | 201 the run, `previewed`, its counts |

A report row gains `balance` (`line`, `amount`, `currency`; null on other
runs' rows and once purged); its `label` is the row's `user`. A csv run has
no inbounds, product, person or source login.

| Refusal | Status | Meaning |
|---|---|---|
| `csv_columns`, `csv_empty`, `csv_too_many_rows` | 422 | rule 2 |

Item failures: `user_not_found`, `currency_mismatch` (the wallet's currency
changed since the plan and no recorded change converts it). Kept reason:
`wallet_used`. Every other refusal is the engine's.
