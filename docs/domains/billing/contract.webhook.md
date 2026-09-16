---
id: billing
layer: domain
status: active
version: 16
updated: 2026-09-16
---

# Contract — billing / webhook settlement

A topic file of `contract.md` (§10): how a provider's own server settles a
payment (D-32), and what it is worth when the amount that arrived is not the
amount asked. Split out of `contract.deposit.md` when it ran out of room. The
browser-return path stays there.

## Settling by webhook (built — F-104-b, ADR-0051)

| Rule | Why |
|---|---|
| `POST /api/billing/deposit/webhook/:provider/:gatewayId`, public like the callback. `WebhookGatewayMiddleware` finds the gateway across tenants (provider must match) and scopes the **owner** (platform gateway: the `platform_owner` tenant); else a neutral **404**. Limited per gateway (`DEPOSIT_WEBHOOK`, 600/min) | a provider knows no panel host; the owner holds the secret |
| `verifyWebhook(rawBody, headers, secret)` runs first (`rawBody: true` in `main.ts`). Bad signature or **no secret** = **401**, no payment read. `WebhookSecretSource` reads the gateway's `webhook_secret` through `GatewayMerchant` (F-104-c); missing or revoked is `null`, so an unconfigured gateway's door stays closed. A driver declares `settlement` (Stripe is the first `webhook` one, F-104-g); a `webhook` one without `verifyWebhook` fails boot, and its browser return writes nothing (`inquire` `verified` shows success, else pending) | decisions 2, 5, 6 |
| The event's code finds the payment by `(gateway column, gatewayTrackingCode)` on the cross-tenant pool (`id`, `tenantId` only); it settles in **that** tenant through `creditVerified` (`webhook_auto`) or `closeFailed`. Unknown code, ignored type, settled row = **200**, nothing changes | decisions 3, 4. A granted gateway's payment settles in the borrower |

## A payment that arrived for another amount (built — F-104-d, D-32)

`creditForReceipt` + `creditVerified` in `deposit/deposit-settlement.ts`. The user's call: credit what actually arrived.

| Rule | Why |
|---|---|
| A signed `paid` event may carry `received: {amountMinor, currency}` — in the driver's `chargeCurrency` and its `chargeDecimals` minor unit. That is each asset's exponent: a driver converts to its charge currency, or does not report. A receipt in any other currency settles **nothing** (200, row stays open for reconciliation and a person) | the frozen rate is base -> `chargeCurrency`; there is no other rate to value it at |
| **Less** than `chargedAmountMinor`: credited = receipt / 10^decimals / `exchangeRateSnapshot`, floored to the cent. The coupon holds are **released** `cancelled`, never confirmed | a coupon applies only to a full payment |
| **More**: credited = `amountCredited` + surplus at the same rate, floored; holds confirmed as usual. **Exactly** as asked, or no receipt: `amountCredited` unchanged | the payer keeps the discount they paid for, plus what they overpaid |
| The crediting flip writes `amountReceivedMinor` + `receivedCurrency` whenever reported, and a changed `amountCredited` — the money of record, which the ledger row, the settlement accrual and the event use | `wallet_transaction` has no second amount; the payment row it references holds both figures |
| `billing.payment.confirmed` adds `amountAsked`, `chargedAmountMinor` and, when reported, `amountReceivedMinor` + `receivedCurrency` (strings). Additive | both figures reach consumers |
| A receipt worth **under a cent** credits nothing: the row closes `failed` / `nothing_received`, holds released | a zero ledger row is not money; nothing more arrives under that authority |
| A payment with no rate (free path) values no receipt and credits as asked. A driver that cannot report a receipt throws `amount_mismatch` from `verify`, which stays F-092-l's `flagged_mismatch` | row note |
