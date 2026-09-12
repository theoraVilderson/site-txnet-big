---
id: billing
layer: domain
status: active
version: 4
updated: 2026-09-12
---

# Contract — billing / wallet history

A topic file of `contract.md` (§10): the financial page's read side. Its
consumer is the panel (F-093-d, and F-093-c for the balance in the top bar) —
the same split as [contract.deposit.md](contract.deposit.md), which owns the
top-up page.

## Routes (built — F-092-n)

`WalletHistoryController` + `WalletHistoryService` in `billing-service/src/app/wallet/`.
Both routes sit behind the gate like every billing route ("Request edge" in
`contract.md`): **whose** wallet is read comes from `X-User-Id`, never from the
query, so neither route has an id to authorise.

| Route | Query | Answers `data` |
|---|---|---|
| `GET /api/billing/wallet/history` | `page`, `pageSize` (≤ 100), `types[]`, `direction`, `from`, `to`, `search` | `{balance, total, page, pageSize, rows[{id, amount, direction, reasonType, referenceId, balanceAfter, createdAt}]}` |
| `GET /api/billing/wallet/payments` | `page`, `pageSize` (≤ 100), `statuses[]`, `from`, `to` | `{total, page, pageSize, rows[{id, status, amountRequested, fee, discount, amountCredited, charge{amountMinor, rate}, trackingCode, referenceId, cardPanMasked, failureCode, gateway{source, id, displayName}, createdAt, expiresAt}]}` |

## Rules

| Rule | Why |
|---|---|
| `balanceAfter` is the column the ledger wrote, and `balance` is `wallet.cachedBalance` — written only inside the same balance-changing transaction (invariant 1). Nothing on this page is recomputed from amounts | legacy walked back from the current balance over the rows it had skipped, counting `pending` and `failed` attempts as movements, so one abandoned top-up skewed the column on every row above it |
| **A payment attempt is not a ledger row**, and the two are separate lists. Only a `success` payment has a ledger row (F-092-j writes it); a `pending` or `failed` one carries a `status` and no balance | they shared one Mongo collection in legacy, which is what let the arithmetic above count a failure as money |
| A user with no wallet is `balance: "0.00"` and an empty page, not a **404** — as a debit reads a missing wallet as a zero balance ("Wallet ledger" in `contract.md`) | the page exists before the first top-up does |
| The `search` term is matched against the **translated label of each `WalletReasonType`** in the request's language, and the types that match become the filter. A term matching no label answers an empty page, never the whole ledger | a `wallet_transaction` has no free text: legacy's Persian `title` column was itself derived from the type, so the label is the same string with no column to rot. Decided 2026-09-12 with the user, over adding a stored title (a schema change, and translated text in Postgres against C-01) |
| The term is folded before it is matched: `آ`/`ا`, `ی`/`ي`/`ئ`, `ک`/`ك`, `ه`/`ة`, and a space and a ZWNJ (`‌`) as the same gap — in the term as well as in the label. It is escaped first, so a `.` a user typed is text, not a pattern | both spellings of every one of those are correct, and an exact match answers "no results" to a search typed right. The fold runs in process over eight labels, so nothing is interpolated into SQL (`persian-search.ts`) |
| `search` and `types[]` **intersect**; the search never widens a narrowed page | asking for transfers and typing "transfer" must answer transfers, not everything |
| The labels are the `billing` namespace of `locale-service` (`reasonType.<value>`), with the default language as the fallback for an untranslated one | a language nobody has translated yet must stay searchable, not silently answer an empty page |
| `from` / `to` are **ISO-8601 instants**, and the calendar is the panel's: a Persian user picks a Jalali date, an English one a Gregorian date, and the picker resolves the day's start and end in their own zone before asking. `from > to` is **400** | a service taking `1405/06/10` would hold a calendar and guess a zone, and answer two different pages to two users who picked the same day (decided 2026-09-12 with the user) |
| Rows are ordered `createdAt` desc, then `id` desc | two rows of one transaction share a timestamp, and an unstable order repeats or skips one across pages |
| Both lists read in a `tenantTransaction`. `paymentTransaction` joins `TENANT_SCOPED_MODELS` here — the first row to query it (`tenant-context/contract.md` rule 2) — so the tenant is a filter and not only a header. `wallet` carries no `tenantId` and is reached through `ownerUserId` | the list filters on a user id that arrives in a header; without the scope a page is one mis-set header away from another tenant's payments |
| A payment's columns are selected explicitly, and it names its gateway as `{source, id, displayName}` — exactly one of the two gateway columns is set (ADR-0006, F-092-d). No `merchantId`, no `*Encrypted` column, ever | invariant 8, and the same explicit list the deposit routes use |
| Neither route raises a domain error: a filter matching nothing is an empty page. The only failures are a malformed query (**400**) and the limiter (**429**) | so this controller maps no i18n key of its own, unlike the deposit routes |
| Per user, per 900s: `WALLET_HISTORY_RATE_LIMIT` (default 180), `WALLET_PAYMENTS_RATE_LIMIT` (default 120) | the page refetches on every filter change, so the budget is the user's typing speed, not a bank's limit (F-092-r) |

**Not covered:** amounts are base currency (ADR-0019); the display-currency step
arrives with F-025. The ledger rows a `success` payment produces are F-092-j's
to write — until it lands, `payments` is the only list with rows in it.
