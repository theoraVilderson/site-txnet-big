---
id: billing
layer: domain
status: active
version: 1
updated: 2026-10-06
---

# Contract — billing / money a provider takes back after credit (CB-1)

A payer disputes a card or PayPal top-up that is already in their wallet, or
the seller refunds it from the provider's dashboard. Decided by the user on
2026-10-06 (D-61, ADR-0125); written before any of it is built, so an
implementing session has nothing left to decide. **Nothing below exists yet**
— each rule names its backlog row. The pages are
[panel-web/contract.disputes.md](../../interfaces/panel-web/contract.disputes.md).

## A worked example (the rules below must reproduce it)

User U has 5.00 in the wallet, tops up 10.00 by PayPal, buys a 8.00 service:
balance 7.00. U opens a PayPal dispute for the whole payment.

1. `dispute_opened`: share S = 10.00. Free balance 7.00 → **7.00 held**,
   **3.00 uncovered**. Shortfall 3.00 > 0 → the account is **locked**: the
   8.00 service is hard-frozen, U can spend nothing, no PayPal/Stripe offered.
   U and the tenant's admins are told.
2. a. U **loses**: the 7.00 hold is captured (`payment_chargeback` debit →
   balance 0.00); 3.00 stays owed; U is **barred** from reversible gateways.
   U tops up 5.00 by crypto: 3.00 pays the debt (`chargeback_recovery`),
   2.00 is free; the shortfall is 0 → the service unfreezes. The bar stays
   until an admin lifts it. Net: U kept their own 5.00, minus the 3.00 of the
   PayPal money they spent — the user's rule.
   b. U **wins** (the seller won): the hold is released, uncovered is 0, the
   lock lifts, the services unfreeze; no bar.

Had U not spent anything (balance 15.00): 10.00 held, nothing uncovered, no
lock, services untouched, U may spend the free 5.00 — only the reversible
gateways are hidden while the dispute is open.

## Storage (CB-1-a)

| # | Rule |
|---|---|
| S1 | `billing.payment_dispute`: `id`, `tenantId` (the payment's; RLS like `payment_transaction`), `paymentTransactionId`, `walletId`, `kind` (`dispute` \| `refund` \| `reversal`), `providerRef` (dispute id / refund id / `reversal:<captureId>`), `status` (`open` \| `won` \| `lost` \| `applied`), `amountMinor` (BigInt, the payment's `chargeCurrency`), `amount` (Decimal 18,2, the wallet's currency — S), `currencyCode`, `held`, `debited`, `uncovered` (Decimal 18,2, each ≥ 0), `holdId` (nullable → `wallet_hold`), `openedAt`, `closedAt`, `writtenOffBy`, `writeOffReason`. `UNIQUE (paymentTransactionId, providerRef)`. `CHECK (held + debited + uncovered <= amount)` |
| S2 | `billing.wallet.disputeShortfall Decimal(20,4) NOT NULL DEFAULT 0` — the sum of `uncovered` over the wallet's `open`/`lost`/`applied` rows, written only together with them (as `heldAmount` is with holds; a deferred trigger checks it at commit) |
| S3 | `billing.dispute_restriction`: `id`, `tenantId`, `userId`, `sourceDisputeId`, `createdAt`, `liftedAt`, `liftedBy`, `liftReason`. One active per user: `UNIQUE (tenantId, userId) WHERE liftedAt IS NULL`. RLS |
| S4 | `billing.gateway_settlement_reversal`: `disputeId UNIQUE`, `grantId`, `tenantId` (the borrower), `amount > 0`, `currencyCode`, `createdAt`. Still owed = accruals − reversals − payouts, which may go below zero (the borrower owes the lender) |
| S5 | `WalletReasonType` gains `payment_chargeback`, `payment_refund` (debits; `referenceId` = the dispute row; each `UNDOES` `payment_gateway` in revenue and analytics) and `chargeback_recovery` (a debit; `referenceId` = the dispute row; also `UNDOES`). `GrantFreezeReason` (F-0401-a's freeze) gains `payment_dispute` — the column itself is CB-1-f's if F-0401-a did not add one |

## The port (CB-1-b)

| # | Rule |
|---|---|
| E1 | `PaymentProvider` gains `readonly reversible: boolean`, **required**: `paypal`, `stripe`, `airwallex` true; `zarinpal`, `idpay`, `nowpayments`, `oxapay`, `telegram_stars`, `bale` false |
| E2 | `WebhookEvent` gains `{kind: 'dispute_opened', referenceId, disputeId, amount?}`, `{kind: 'dispute_won', referenceId, disputeId}`, `{kind: 'dispute_lost', referenceId, disputeId, amount?}`, `{kind: 'refunded', referenceId, refundId, amount}`. `amount` = `{amountMinor, currency}` in the payment's charge currency; missing = the whole payment |
| E3 | The door finds these by `gatewayReferenceId` (+ the gateway column), not by authority, cross-tenant like today, then acts in the payment's tenant. A payment not `success` → logged and `accepted` (an open payment's reversal is still F-092-ae's `reversed`). An amount in another currency → logged, `accepted`, nothing taken (as F-104-d) |
| E4 | An existing `reversed` event for a `success` payment (today ignored) becomes a `reversal` row applied at once as a loss — unless the payment has an `open` or `lost` dispute, in which case it is that dispute's money and changes nothing |

## The money (CB-1-c)

| # | Rule |
|---|---|
| M1 | **Share.** S = `amountCredited × amountMinor / chargedAmountMinor`, half-up to the cent, capped at `amountCredited − Σ amount` of the payment's other rows not `won`. A cap of 0 → row written `applied` with `amount 0`, nothing moves (a dispute after a full refund) |
| M2 | Wallet currency ≠ payment `currencyCode` (an F-116-f change since): S is carried through each `currency_change` that converted this wallet since the payment, at its own rate (contract.currency-change.md), and frozen on the row. None found → the row is written `open` with `uncovered = 0`, nothing held, and flagged for a person (`payment_reconciliation_log`, `flagged_mismatch`) |
| M3 | `dispute_opened` → row `open`; `held = min(S, free balance)` as a `wallet_hold` (owner ref `dispute:<id>`); `uncovered = S − held` |
| M4 | `dispute_lost` → capture the hold (`payment_chargeback`), `debited += held`, `held = 0`, status `lost`; a restriction (S3) is written if none is active. A loss with no `open` row first (PayPal can send RESOLVED without CREATED) runs M3 then M4 in one transaction |
| M5 | `dispute_won` → release the hold, `held = 0`, `uncovered = 0`, status `won` |
| M6 | `refunded` → like M3 + M4 at once, ledger reason `payment_refund`, status `applied`, **no restriction**. `reversal` (E4) → reason `payment_chargeback`, status `lost`, restriction written |
| M7 | **Every credit pays the shortfall first.** In the shared-core ledger's credit path, same transaction: when `disputeShortfall > 0`, X = min(credit, shortfall) goes to the wallet's rows oldest `openedAt` first — an `open` row's hold grows by it, a `lost`/`applied` row gets a `chargeback_recovery` debit — and `uncovered` falls by it |
| M8 | **The lock** is `disputeShortfall > 0`. While locked, the ledger's `debit()` refuses every reason except `payment_chargeback`, `payment_refund`, `chargeback_recovery`, `currency_change`, `admin_manual_adjust` with `wallet_locked_dispute` (a typed error each route maps to an i18n key, C-01). Captures of existing holds are not debits and pass |
| M9 | **Write-off** (CB-1-i): an admin sets a row's `uncovered` to 0 with a reason — no ledger row, an `admin_audit_log` row in the same transaction |
| M10 | A row's events are idempotent by `(paymentTransactionId, providerRef)` and its status: a repeated `dispute_lost` changes nothing; `won` after `lost` is logged and changes nothing (a person reverses it with `admin_manual_adjust`) |

## Locked out, barred, told (CB-1-c..h, CB-1-p)

| # | Rule | Row |
|---|---|---|
| L1 | When `disputeShortfall` goes 0 → >0, the same transaction hard-freezes every active Grant of the wallet's owner (F-0401-d's freeze, `freezeMode hard`, reason `payment_dispute`, `freezeStopsClock false`); >0 → 0 unfreezes only Grants frozen with reason `payment_dispute` — an admin's own freeze stays | CB-1-f |
| L2 | **The bar.** A user with an active restriction or an `open` dispute: the gateway list and quote leave out every gateway whose driver is `reversible`; `start` on one answers `403 gateway_restricted_dispute`. Admin lift: S3's `liftedAt/By/Reason` | CB-1-e |
| L3 | **Granted gateway**: a loss, reversal or refund on a payment with a `gateway_settlement_entry` writes one `gateway_settlement_reversal` of `amount × entry.amount / amountCredited` (half-up), in the same transaction | CB-1-h |
| L4 | **Events**, written in the transaction that moves the money (outbox, ADR-0021): `billing.dispute.opened`, `.won`, `.lost`, `.refunded`, `billing.dispute.lock_changed {locked}`, payload `{tenantId, userId, walletId, disputeId, paymentId, amount, held, uncovered, currencyCode}`. Each is a `LIVE_PUSH_FIELDS` row on `user:<id>` and `tenant:<id>` (ADR-0121). The row that moves the money writes its event (C-14) | CB-1-c |
| L5 | **Notices** (`EventNoticeSender`): the user on opened/lost/won/lock_changed (templates `disputeOpened`, `disputeLost`, `disputeWon`, `accountUnlocked`); the tenant's staff holding `payment.confirm_manual` on opened and lost (`disputeStaffAlert`); the gateway's owner tenant's staff too when it is a platform or granted gateway | CB-1-g |
| L6 | **A reseller's own top-up** (`billingTenantId`): the same rules on the wallet that was credited; the platform's staff are told; the reseller's tenant is never suspended automatically — a person's call | CB-1-c |
| L7 | **Another account on the same device.** When a restriction is written, every account of the tenant sharing a device fingerprint with the user (F-036-a, `fraud.device_fingerprint`) gets a `fraud_flag` (`kind chargeback_link`) and its own restriction (`sourceDisputeId` the same); staff are told and lift each one alone | CB-1-p |

## Admin routes (CB-1-i)

Permission `payment.confirm_manual` (the manual-payments queue's), tenant
scoped by RLS; platform staff see their own tenant's as everywhere else.

- `GET /api/billing/disputes?status=&userId=&cursor=` — rows with the payment,
  gateway, user, `amount`, `held`, `debited`, `uncovered`, `status`.
- `GET /api/billing/disputes/:id`.
- `POST /api/billing/disputes/:id/write-off {reason}` — M9; `409` when
  `uncovered` is already 0.
- `GET /api/billing/dispute-restrictions?active=true`,
  `POST /api/billing/dispute-restrictions/:id/lift {reason}` — L2.
- The user's own `GET /api/billing/wallet` answers `disputeShortfall`, the
  held-for-dispute sum, and `restricted: boolean`.

## Providers (CB-1-j, CB-1-k, CB-1-l)

| Provider | Mapping |
|---|---|
| **PayPal** (CB-1-j) | `CUSTOMER.DISPUTE.CREATED` → `dispute_opened` (`referenceId` = `disputed_transactions[0].seller_transaction_id`, `disputeId` = `dispute_id`, `amount` = `dispute_amount`); `CUSTOMER.DISPUTE.RESOLVED` → by `dispute_outcome.outcome_code`: `RESOLVED_BUYER_FAVOUR`, `ACCEPTED` → `dispute_lost`; `RESOLVED_SELLER_FAVOUR`, `CANCELED_BY_BUYER`, `DENIED`, `RESOLVED_WITH_PAYOUT` → `dispute_won`; `CUSTOMER.DISPUTE.UPDATED` → `ignored`. `PAYMENT.CAPTURE.REFUNDED` → `refunded` (resource = the refund: `refundId` = `id`, `amount`, capture id from the `links[]` `rel: up` href); `PAYMENT.CAPTURE.REVERSED` → `reversed` (E4) |
| **Stripe** (CB-1-k) | `charge.dispute.created` → `dispute_opened` (`referenceId` = `payment_intent`, `disputeId` = dispute `id`, `amount`); `charge.dispute.closed` → `status` `lost` → `dispute_lost`, `won` / `warning_closed` → `dispute_won`; `refund.created` / `refund.updated` with `status: succeeded` → `refunded` (`refundId` = `id`, `referenceId` = `payment_intent`). The help text adds these events to the webhook's subscription |
| **Airwallex** (CB-1-l) | Its `payment_dispute.*` and `refund.*` events, mapped the same way after the builder checks airwallex.com/docs; the facts go in this row and in `contract.webhook.md` |
