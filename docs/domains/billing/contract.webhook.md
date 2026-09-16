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
| `verifyWebhook(rawBody, headers, secret)` runs first (`rawBody: true` in `main.ts`). Bad signature or **no secret** = **401**, no payment read. `WebhookSecretSource` reads the secret the provider signs with (`provider-fields.ts` `webhookSignedWith`: `webhook_secret`, or OxaPay's merchant key) through `GatewayMerchant` (F-104-c, F-104-i); missing or revoked is `null`, so an unconfigured gateway's door stays closed. A driver declares `settlement` (Stripe is the first `webhook` one, F-104-g); a `webhook` one without `verifyWebhook` fails boot, and its browser return writes nothing (`inquire` `verified` shows success, else pending) | decisions 2, 5, 6 |
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

## Telling the provider, and the payer's return (built — F-104-h)

| Rule | Why |
|---|---|
| `start` hands a `webhook` driver `webhookUrl` = the callback's origin + `/<prefix>/billing/deposit/webhook/<provider>/<gatewayId>` (`webhookUrlFor`). A driver whose provider takes it per payment refuses without it (`invalid_request`) | one provider account can serve several gateways; no dashboard setting per gateway |
| A callback with **no authority** but a valid `?p=` answers a **webhook** payment by its row: `success` / `failed` from its status, else `inquire` on the row's own authority (or `verifying`). A return-settled gateway still gets `INVALID_PARAMS` | NOWPayments and OxaPay have no placeholder for the invoice id; the return only shows, never credits |
| A signed `reversed` event closes an open payment through `closeReversed` (F-092-ae) | a refund is not a failure: the payer is told |

## Drivers settled here

| Driver | Rule | Why |
|---|---|---|
| **NOWPayments** (F-104-h, `nowpayments.provider.ts`; docs checked 2026-09-16) | `POST /v1/invoice` in USD with `x-api-key` (`secretKey`), never retried; authority = invoice id, reference = `payment_id`. IPN `x-nowpayments-sig` = HMAC-SHA512 hex with the IPN secret over the body **recursively** key-sorted, compact. `finished` paid (surplus reported as a receipt), `partially_paid` paid for `price_amount × actually_paid / pay_amount` in USD cents (pending if not computable), `refunded` reversed, no `invoice_id` ignored. Host `api-sandbox.nowpayments.io` under `PAYMENT_GATEWAY_SANDBOX` | the docs' own Node and Python examples |
| NOWPayments `waiting`/`confirming`/`confirmed`/`sending` **and `failed`/`expired`** are pending | one invoice holds several payments (coin switched, re-deposit); closing on one would refuse the one that pays. Our clock expires the row; credit accepts expired |
| NOWPayments `inquire` = `in_bank` with no call; `verify` = `unavailable`; `quoteFee` refused | finding a payment by invoice id needs a login JWT a gateway does not hold. The IPN, which NOWPayments repeats, is the only settlement |
| **OxaPay** (F-104-i, `oxapay.provider.ts`; docs checked 2026-09-16) | `POST /v1/payment/invoice` in USD with header `merchant_api_key` (the `merchantId` slot), `callback_url` = `webhookUrl`, `return_url` = callback, `sandbox: true` under `PAYMENT_GATEWAY_SANDBOX`; never retried; authority = `track_id`, reference = first `tx_hash`. Callback header `HMAC` = HMAC-SHA512 hex over the **raw** body with the merchant key. `paid`/`manual_accept` paid, `refunded` reversed, `new`/`waiting`/`paying`/`refunding` pending, a payout ignored. `inquire`/`verify` read `GET /v1/payment/{track_id}` (one retry on silence); `verify` checks `amount` = asked in USD | docs.oxapay.com webhook, invoice and status table |
| OxaPay **`underpaid` is pending**, never a receipt; `expired` fails only an invoice with no `txs` | the docs do not say which of `amount`/`value`/`txs[].value` is the USD that arrived — a guessed figure is a guessed credit. Money sent to an expired invoice is not closed away |
| The webhook door answers **200 `ok`** (text/plain) to every accepted post | OxaPay counts a delivery only by that body and retries 5 times; the others read the status |
