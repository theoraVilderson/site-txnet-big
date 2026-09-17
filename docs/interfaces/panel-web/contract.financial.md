---
id: panel-web
layer: interface
status: active
version: 14
updated: 2026-09-12
---

# Contract — panel-web: the financial page (F-093-d)

A topic file of [contract.md](contract.md) (§10): `/financial`, the first page
in this app that reads a list from `billing`. Its producer is
[domains/billing/contract.history.md](../../domains/billing/contract.history.md)
— that file owns what the two routes answer, and this one owns what the page
does with it. The kit it is built from is [contract.kit.md](contract.kit.md);
the menu entry and the wallet quick action that reach it are
[contract.shell.md](contract.shell.md).

Route constant `PANEL_FINANCIAL` in `src/lib/routes.ts`. Files under
`(panel)/financial/`.

## Two lists, never one table

**The page has two tabs and they are two different things.** The ledger is
money that moved; the payments list is top-up attempts, most of which moved
none. Only a `success` payment has a ledger row at all, and F-092-j is what
writes it.

This is the whole reason F-092-n exists, so it is not a layout preference and a
later row must not "simplify" it back. Legacy kept both in one Mongo collection
and ran a balance down the merged table, so one abandoned top-up shifted the
balance column of every row above it — permanently, and invisibly.

| | ledger tab | payments tab |
|---|---|---|
| route | `GET /wallet/history` | `GET /wallet/payments` |
| a row is | a movement: `direction`, `reasonType`, `amount`, `balanceAfter` | an attempt: `status`, requested / fee / discount / credited, a gateway |
| has a status | no — it exists because money moved | yes, and `pending` / `failed` / `expired` moved nothing |
| has a balance | yes, as the ledger wrote it | no |
| its own filters | reason type, direction, search | status |

## Rules a later row has to know

1. **The URL is the state.** Tab, page and every filter are read from the query
   string and written back to it (`_lib/filters.ts`), so a filtered view is a
   link that survives a reload and can be pasted into a support ticket. Nothing
   is mirrored into a store beside it — legacy had the filter panel holding its
   own copy, and the two disagreed about what was applied.
2. **A day is not an instant, and resolving it is this side's job.** The picker
   answers a Gregorian `YYYY-MM-DD` whichever calendar it drew, and the routes
   take ISO-8601 instants. `startOfDayInstant` / `endOfDayInstant` turn the
   picked day into the moment it began and the *last millisecond* of it, in the
   viewer's own zone. Not the next midnight: `to` is inclusive (`lte`) on the
   service side, so midnight would include the following day's first second.
   The service deliberately holds no calendar and no zone
   (`contract.history.md`, decided 2026-09-12).
3. **Each route is given only its own filters.** `ledgerQuery` and
   `paymentsQuery` are separate functions for that reason, and the filter panel
   shows only the fields the open tab can use. A `statuses` filter reaching the
   ledger query is the legacy merge growing back through the query string.
   Switching tabs keeps the date range and drops the rest (`forTab`).
4. **An empty filter is absent from the query, never sent blank.** An empty
   `search` is not "no search" to the service: it reaches `foldedSearch`, and a
   term matching no label answers an empty page.
5. **Filters apply on Apply, not per keystroke.** Both routes are rate-limited
   per user per 900s (`WALLET_HISTORY_RATE_LIMIT`, default 180), and a filter
   that fired while typing would spend that budget on one search term.
6. **Nothing on this page computes a balance.** `balanceAfter` is printed as
   the ledger wrote it and the header figure is the route's own `balance` —
   never a total added up from the rows on screen, and never the previous row's
   figure adjusted by an amount. Same rule as the top bar's
   (`contract.shell.md`, "The wallet control").
7. **A failed read and an empty list are different states.** They were one in
   legacy, so a rate-limited user was told they had no transactions. A failure
   shows the server's own translated line (`useApiErrorMessage`) and a retry;
   an empty page shows the empty state. Rows are cleared on a failure, because
   the previous filter's rows under the new filter's heading would be a lie.
8. **The skeleton is derived, not scheduled.** `useFinancialPage` computes
   `isLoading` from whether the current query is the one that last landed, so
   the skeleton is up in the same render that changed the filter. Legacy needed
   a `Suspense` key on the serialised search params *and* a `LoadingContext`
   that the filter panel poked; both are gone. The one `Suspense` left, in
   `page.tsx`, exists because Next will not prerender a `useSearchParams`
   without it.
9. **Only theme tokens, never a raw palette class.** Three themes ship
   (`globals.css`); the badge tones live in `_lib/tones.ts` and an
   `emerald-500` written inline is legible in one theme by luck.
10. **A verifying payment reads "در حال تأیید", not "pending" (F-093-m).** The row
   stays `pending` (F-092-x); `paymentTone(row)` picks `VERIFYING_TONE` (theme
   green, a shield — never gold) when the route's `verifying` is set, and the
   row stops showing an expiry, because that clock no longer closes it. There is
   no status filter for it: it is a `pending` attempt, and filtering `pending`
   finds it.

## The reseller's billing page — `/financial/billing` (F-019-d)

`PANEL_TENANT_BILLING`, files under `financial/billing/`. A reseller's prepaid
balance **with the platform** and its movements, read from
`GET /api/billing/tenant-wallet` (producer: `domains/tenant/contract.billing.md`).
It is not the user's wallet and shares no list with the two tabs above.

- Rules 1, 6, 7 and 8 above hold unchanged: `?page=` is the state, the header
  is the route's `balance`, a failure is the server's line and a retry, loading
  is derived. There are no filters (the route takes none).
- Reason labels live in `common.tenantBilling.reason`, the tenant ledger's own
  set; an unknown value renders as itself.
- **The menu decides nothing about access.** The entry needs
  `tenant_billing.topup` *and* a reseller (`contract.shell.md` rule 2); the
  route also admits the reseller's owner without that key, who then reaches the
  page by URL. A refusal is rendered as rule 7's failed read.
- No top-up form yet: `POST /tenant-wallet/topup` has no page.

## Not covered

- **The individual gift codes of a discounted payment.** Legacy's expanded row
  listed them; `GET /wallet/payments` answers the `discount` amount and no
  codes (`contract.history.md`'s column list), so the page shows the amount.
  Adding them is a `billing` change first, and a row of its own.
- **A display currency.** Every amount is formatted in the base currency
  (ADR-0019). F-025 is the row that brings the conversion, and it changes the
  arguments to `formatMoney`, not this page's data path.
- **Live updates.** The lists are read when the filters change and on retry. An
  event on `user:<userId>` re-reads the top bar's balance (F-093-c) but not
  these tables; a payment landing while the page is open is one refresh away.

## Proof

`_lib/filters.test.ts` — the day-to-instant resolution, the two queries staying
apart, an absent filter staying out of the query, and the URL round-trip.
