---
id: panel-web
layer: interface
status: active
version: 1
updated: 2026-10-06
---

# Contract — panel-web: disputed top-ups, a locked account, and the disputes page (CB-1)

What a user sees when a card or PayPal top-up is disputed or refunded, and
the staff page that lists disputes. Decided by the user on 2026-10-06 (D-61,
ADR-0125); written before any of it is built — each rule names its backlog
row. Routes, fields and money rules are
[billing/contract.disputes.md](../../domains/billing/contract.disputes.md);
this file never redefines one. PayPal's gateway form is
[billing/contract.paypal.md](../../domains/billing/contract.paypal.md) "What
the panel asks". Gold is never on a button or control; motion follows
contract.ux.md M1–M4.

## The user (CB-1-n)

| # | Rule |
|---|---|
| U1 | The wallet card (`useWalletBalance`) reads `disputeShortfall`, the held-for-dispute sum and `restricted` from `GET /api/billing/wallet`. Held > 0: a line under the balance, "{amount} held for a payment dispute". Shortfall > 0: a red banner on the wallet card and on `/financial`, "Your account is limited: {amount} of a disputed payment was already spent. Top up {amount} to unlock it", with a button to `/financial/deposit?amount=<shortfall>` |
| U2 | The top-up page lists what billing answers — reversible gateways are already left out (L2). When `restricted` is true or a dispute is open, one muted line above the list: "Card and PayPal payments are unavailable on this account. Contact support." No gateway is hidden in the panel itself |
| U3 | `wallet_locked_dispute` and `gateway_restricted_dispute` map to their own i18n keys in `contract.errors.md`'s map (`errors.billing.walletLockedDispute`, `errors.billing.gatewayRestrictedDispute`), shown where any refused purchase or start is shown today |
| U4 | `/services`: a Grant frozen with reason `payment_dispute` reads "Frozen — payment dispute" with no unfreeze button and a link to the wallet; the user's own freeze controls (F-0401-e) do not apply to it |
| U5 | `/financial` history: a `payment_chargeback`, `payment_refund` or `chargeback_recovery` row names the payment it undoes ("PayPal top-up of 2026-10-01 disputed"). The top-up attempts list marks a payment with a dispute: open / lost / won / refunded |
| U6 | All of it re-reads live on `billing.dispute.*` and `billing.wallet.changed` through `useLiveReread` (ADR-0121) — no poll |

## Staff (CB-1-m)

| # | Rule |
|---|---|
| A1 | New page `/payments/disputes` beside `/payments/manual`, menu entry under the same group, shown to `payment.confirm_manual`. Tabs: Open, Lost, Won, Refunded; columns: user, payment (date, gateway, amount in charge currency), share, held, uncovered, status, opened. Pager from the kit |
| A2 | A row opens a drawer: the payment, the provider's dispute or refund id, the timeline (opened, won/lost, write-off), and two actions. **Write off** (only when `uncovered > 0`): a reason box, required, confirm dialog naming the amount → `POST …/write-off`. **Lift the card/PayPal bar** (only with an active restriction for the user) → `POST …/dispute-restrictions/:id/lift {reason}` |
| A3 | A staff alert (`disputeStaffAlert`) in the bell links to the drawer (`/payments/disputes?open=<id>`) |
| A4 | The staff user page (`/accounts/:id`) shows a "Payment dispute" badge while the user is locked or barred, linking to their rows |
| A5 | The page re-reads on `billing.dispute.*` on `tenant:<id>` (ADR-0121) |
| A6 | A `SURFACES.md` row `panel-disputes` (aliases: disputes page, chargebacks, payment disputes, اعتراض پرداخت, برگشت پول, شکایت پی‌پال) lands with the page |
