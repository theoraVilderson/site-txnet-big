---
id: panel-web
layer: interface
status: active
version: 40
updated: 2026-09-29
---

# Contract — panel-web: a service's spending cap, and held money apart (F-118-j)

The owner's side of billing's spending cap (F-118-i, F-608, D-58, ADR-0105 (9);
server rules: [billing/contract.spending-cap.md](../../domains/billing/contract.spending-cap.md)),
and the wallet's held money shown apart from what can be spent
([billing/contract.holds.md](../../domains/billing/contract.holds.md)).

Pieces: `services/_components/SpendingCap.tsx` (under a row's "manage"),
`services/_components/WalletFunds.tsx` (above the list), `services/_lib/spending-cap.ts`
(the amount parser, `capReached`, `capOffered`), `_components/WalletButton.tsx`
and `_hooks/useWalletBalance.ts` (the top bar), `lib/billing-api.ts`
(`spendingCap`, `setSpendingCap`, `removeSpendingCap`; `WalletBalance.held/available`).

## The cap, under "manage"

1. **Read once when "manage" opens**, `GET .../traffic/grants/:id/cap` — like
   the 30 days, nothing is read for a folded row. Not drawn on an `expired` or
   `cancelled` service: billing answers a closed Grant `404` like a missing id.
   A failed read is billing's sentence and a retry, never "no cap".
2. **Every figure is billing's.** Who it is for (`label`), the cap, and
   `spent` / `held` / `left` as billing answered them; a monthly cap names the
   day its period started. `left` of zero says the service is stopped until the
   cap is raised or removed (billing rule 4). Nothing here subtracts money (C-02).
3. **One form sets, raises or lowers** — `PUT` with `{label, amount, period}`.
   The label is trimmed, 1..40; the amount is read with Persian or Arabic
   digits, `٫` and thousands separators, and must be above zero with at most
   two places, or the form says so and sends nothing. Billing checks the same
   and its sentence (`billing.spendingCapInvalid`) is what a refusal shows,
   with its `ref`, keeping what was typed. The amount is in the wallet's
   currency (billing rule 7), named in the box's label. A changed period says
   first that the count starts again from today (billing rule 6).
4. **Removing asks first**, "keep the cap" focused: with no cap the service may
   spend the whole wallet. `DELETE` answers `204`; the section then says "no cap".
5. **The row shows billing's answer, never the draft**, and a stored write asks
   the page to re-read the wallet (`onCapChanged` -> `useWalletBalance().refresh`):
   a cap tops or releases the service's reserve, and a hold writes no event.

## Held money apart

6. **What can be spent is the figure.** `GET /wallet/history` answers `held`
   and `available` (`balance − held`) beside `balance` (billing
   [contract.history.md](../../domains/billing/contract.history.md)). The top
   bar and the shop's checkout line show `available`: a purchase cannot spend
   held money (F-118-a), so the balance would promise what pay refuses. The
   deposit and financial pages keep `balance` — the ledger's own column.
7. **Held is said only when there is some**, read off billing's string: the
   wallet dropdown adds "held for your services" with one sentence of why, and
   the button's caption reads "available"; My services shows available and
   held in one strip above the list (`WalletFunds`). A failed read is its own
   line, never a zero ([contract.shell.md](contract.shell.md) wallet rule 5).
8. **`held` is as of the last read.** A hold moving writes no outbox event
   yet, so the figure follows the next wallet event, reconnect, page open or
   cap write — the same re-read as the balance (shell wallet rule 1).

## Proof

`services/spending-cap.test.tsx` — the amount parser (Persian digits, `٫`,
separators, zero and three places refused), `capReached` on `left`; the cap
read only when "manage" opens and not offered on an expired service; spent,
held, left and the label as billing answered; the stopped line; a set in
billing's shape that shows billing's answer and tells the page; an invalid
amount sending nothing; a refusal keeping the form with sentence and ref; the
period warning; remove asking first with keep focused; a failed read and its
retry; the wallet strip with held apart, silent at zero, and not a zero on a
failed read. Server side: billing `wallet/wallet-history.spec.ts` (`held`,
`available`) and `usage/spending-cap.spec.ts`.

## Not covered

The bot's screens for the same cap (a row of their own, F-608). The cut
itself is told by billing's `cap_reached` notice (F-118-t), not by this page. Since F-118-o a hold moving writes
`billing.wallet.changed` (at most once per 30 s per wallet), so `held` follows
the re-read the page already does on it. The cap is not shown on the folded row.
