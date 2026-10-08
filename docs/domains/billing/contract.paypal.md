---
id: billing
layer: domain
status: active
version: 1
updated: 2026-10-06
---

# Contract — billing / PayPal, and a charge currency per gateway (PP-1)

Decided by the user on 2026-10-06 (D-61, ADR-0124); written before any of it
is built, so an implementing session has nothing left to decide. **Nothing
below exists yet** — each rule names the backlog row that builds it. Money
taken back after credit (disputes, refunds) is
[contract.disputes.md](contract.disputes.md). A provider fact that turns out
wrong against developer.paypal.com is said in one line in the row's note and
the rule corrected here — the builder checks the docs, never asks.

## Charge currency per gateway (PP-1-a, PP-1-b, PP-1-c)

| # | Rule | Row |
|---|---|---|
| 1 | `billing.payment_gateway.chargeCurrency` and `tenant.tenant_gateway_config.chargeCurrency`: `text NULL`, ISO 4217 upper-case (`CHECK (chargeCurrency ~ '^[A-Z]{3}$')`). Null = the driver's default | PP-1-a |
| 2 | `billing.payment_transaction.chargeCurrency text NOT NULL`, added nullable, backfilled in the same migration by `providerName` of the row's gateway (`zarinpal`, `idpay`, `bale` → `IRR`; `telegram_stars` → `XTR`; every other → `USD`), then `SET NOT NULL`. `PaymentProviderName` gains `paypal`. Additive only — no row deleted, no type change | PP-1-a |
| 3 | The port gains `readonly chargeCurrencies?: Readonly<Record<string, number>>` (code → decimals). Missing = `{ [chargeCurrency]: chargeDecimals }`. One resolver, `chargeCurrencyOf(gateway, provider) → { code, decimals }` in `payment/gateway/charge-currency.ts`: the row's value when set, else the driver's `chargeCurrency`. Nothing else reads `provider.chargeCurrency` / `provider.chargeDecimals` | PP-1-b |
| 4 | Readers moved onto it, all in the same row: `deposit-start` (prices with the resolver, writes `payment_transaction.chargeCurrency`), `deposit-quote` (answers it as `currency`), `deposit-pricing.chargeCurrenciesOf` (F-116-j pins), `deposit-webhook` (a receipt in another currency is left unsettled — compare with the **payment's** column), `deposit-in-chat` (both checks), `deposit-follow-on` and every `received.decimals` (the payment's currency's decimals). `PaymentRequestInput` and `PaymentVerifyInput` gain `currency: {code, decimals}` (the payment's), which every caller passes and the existing drivers ignore. `gateway-pricing.ts` and its golden file do not change | PP-1-b |
| 5 | Proof that nothing moved: every existing spec passes unchanged; one new spec `charge-currency.spec.ts` covers the resolver (null → driver default, set → row, a code outside `chargeCurrencies` → throws `InvalidPricingInput`) | PP-1-b |
| 6 | `/api/billing/gateways` (own) and `/api/billing/tenants/:tenantId/gateways` (a reseller's, ADR-0064) accept `chargeCurrency` on create and patch, and answer it resolved (`chargeCurrency`, never null on the wire) plus `chargeCurrencies` (the driver's list, sorted) | PP-1-c |
| 7 | Refused, before any write: a code not in the driver's list → `400 currency_not_supported` naming the field; `useLiveRate = true` and `FxRateReader` has no rate for it → `400 currency_not_rated` (the operator either picks another or turns the live rate off and sets `staticRate`). USD always passes the second check (the pivot) | PP-1-c |
| 8 | Retired by F-104-ak: a tenant gateway has no approval to reset, so a `chargeCurrency` change resets nothing. Open payments are unaffected (rule 2) | PP-1-c |
| 9 | `staticRate`, `minRate`, `maxRate` stay "charge units per one unit of `currencyCode`" (F-0609) — now of the resolved charge currency. The form says which currency (PP-1-i) | PP-1-c |

## The webhook URL is shown (PP-1-h)

`PROVIDER_FIELDS` gains `webhookUrlByHand: boolean` — true for `stripe`,
`airwallex`, `paypal` (their URL is typed into the provider's dashboard), false
for the rest (told per payment, or no webhook). A gateway answer of such a
provider carries `webhookUrl` = `webhookUrlFor(<the gateway's callback origin>,
GLOBAL_PREFIX, {providerName, gatewayId})` — the same function `start` uses,
so the two can never differ. Other providers answer no `webhookUrl` key.

## The PayPal driver (PP-1-f, PP-1-g)

File `payment/gateway/paypal.provider.ts` + `paypal.provider.spec.ts`,
registered in `payment-provider.registry.ts` as
`new PayPalProvider({ sandbox })`. Proved by fixtures copied from
developer.paypal.com (Orders v2, Webhooks); no live account is needed to
reach `done` (as F-104-g).

| # | Rule |
|---|---|
| P1 | `name = paypal`, `settlement = 'return'`, `alsoWebhook = true`, `reversible = true` (CB-1-b adds the property; until then omit it), `chargeCurrency = 'USD'`, `chargeDecimals = 2`, `chargeCurrencies` = AUD 2, BRL 2, CAD 2, CHF 2, CNY 2, CZK 2, DKK 2, EUR 2, GBP 2, HKD 2, HUF 0, ILS 2, JPY 0, MXN 2, MYR 2, NOK 2, NZD 2, PHP 2, PLN 2, SEK 2, SGD 2, THB 2, TWD 0, USD 2 (PayPal's REST currency table; HUF/JPY/TWD take no decimals) |
| P2 | Credentials: client id in the `merchantId` slot, secret in `secretKey`, the webhook **id** in `webhookSecret` (`provider-fields.ts`: `secrets: ['merchantId','secretKey','webhookSecret']`, `webhookSignedWith: 'webhookSecret'`, `webhookUrlByHand: true`). Category `international_card` — no new category |
| P3 | Hosts: `https://api-m.paypal.com`, under `PAYMENT_GATEWAY_SANDBOX` `https://api-m.sandbox.paypal.com`. Timeout 10 s per call |
| P4 | Token: `POST /v1/oauth2/token`, Basic `clientId:secret`, `grant_type=client_credentials`. Cached in-process under a SHA-256 of the pair until 60 s before `expires_in` (Airwallex's rule — no key kept, no token shared across key pairs). A 401 on a cached token: drop it, fetch once more, retry the call once |
| P5 | `request`: `POST /v2/checkout/orders`, header `PayPal-Request-Id: order-<paymentId>` (payment id read from the callback URL's `p`), body `{intent: 'CAPTURE', purchase_units: [{reference_id: <paymentId>, custom_id: <paymentId>, invoice_id: <paymentId>, description: <description ≤127 chars>, amount: {currency_code, value}}], payment_source: {paypal: {experience_context: {return_url: <callbackUrl>, cancel_url: <callbackUrl>&status=NOK, user_action: 'PAY_NOW', shipping_preference: 'NO_SHIPPING', landing_page: 'NO_PREFERENCE'}}}}`. `value` is the minor amount printed with the currency's decimals (`1234n`, 2 → `"12.34"`; JPY → `"1234"`), never via a float. Never retried. `authority` = order `id`; `redirectUrl` = the `links[]` entry with `rel` `payer-action` (fallback `approve`); neither → `unexpected` |
| P6 | The payer returns to `callbackUrl?p=<paymentId>&token=<orderId>&PayerID=…`, or on cancel to `…&status=NOK&token=<orderId>`. The callback reads `token` as the authority when `authority` is absent (PP-1-d) — so a cancel closes the payment `payment_failed` through the existing `status != OK` branch |
| P7 | `verify` **is the capture**: `POST /v2/checkout/orders/{id}/capture`, `PayPal-Request-Id: capture-<orderId>` (so a retry cannot capture twice), retried on transport failure within `deadlineAt`. `422 ORDER_ALREADY_CAPTURED` → read the order (`GET /v2/checkout/orders/{id}`) and judge it as below with `alreadyVerified: true` |
| P8 | Judging a captured order: `purchase_units[0].payments.captures[0]`. `COMPLETED` → success, `referenceId` = capture id, `cardPan: null`; amount and currency must equal the payment's `chargedAmountMinor` / `chargeCurrency` (read as the digits sent, F-104-aa) or `amount_mismatch`. `PENDING` → `unavailable` (the money is not ours yet; the retry ladder and the `PAYMENT.CAPTURE.COMPLETED` webhook finish it). `DECLINED` / `FAILED` → `payment_failed`. `REFUNDED` / `PARTIALLY_REFUNDED` / `REVERSED` → success for the capture as it was (the dispute engine handles the take-back, CB-1-j) |
| P9 | Capture errors: `422 INSTRUMENT_DECLINED`, `PAYER_ACTION_REQUIRED`, `ORDER_NOT_APPROVED` → `payment_failed` (the payer starts a new top-up); `404 RESOURCE_NOT_FOUND` → `authority_invalid`; `401`/`403` → `merchant_rejected`; `429` → `rate_limited`; `400`/other `422` → `invalid_request`; network, timeout, `5xx` → `unavailable`. `providerCode` = PayPal's `name`/`details[0].issue` |
| P10 | `inquire`: `GET /v2/checkout/orders/{id}`. `CREATED`, `SAVED`, `PAYER_ACTION_REQUIRED` → `in_bank`; `APPROVED` → `paid` (F-092-l's sweep then calls `verify`, i.e. captures — how a payer whose browser never came back is still credited); `COMPLETED` → by the capture: `COMPLETED` `verified`, `PENDING` `in_bank`, `DECLINED`/`FAILED` `failed`, `REFUNDED`/`REVERSED` `reversed`; `VOIDED` → `failed` |
| P11 | `verifyWindowSec = 10800` (an approved order not captured lapses after 3 hours — developer.paypal.com "Orders v2, order expiry"; correct here if the docs say otherwise). `listUnverified` omitted. `quoteFee` refuses (`invalid_request`, "PayPal has no fee API; price this gateway with a manual fee"), as Stripe |
| P12 | `verifyWebhook` (async): offline signature check, no API call. Headers `paypal-transmission-id`, `-transmission-time`, `-transmission-sig`, `-cert-url`, `-auth-algo` all required. `cert-url` must be `https:` with host exactly `api.paypal.com` or `api.sandbox.paypal.com` (the sandbox one only under `PAYMENT_GATEWAY_SANDBOX`) — else 401 before any fetch. The certificate is fetched once per URL and cached until its `validTo`; `X509Certificate`: subject CN `messageverificationcerts.paypal.com`, `validFrom ≤ now ≤ validTo`, chain verified against Node's root store. Signed string = `${transmissionId}\|${transmissionTime}\|${webhookId}\|${crc32(rawBody)}` (CRC32 as an unsigned decimal, `zlib.crc32`, Node ≥ 22); `crypto.verify('sha256', …, cert.publicKey, base64(sig))`. Any doubt → `WebhookSignatureInvalid`. No replay window: settlement is status-guarded (ADR-0028), and PayPal retries for days |
| P13 | Events, before CB-1: `PAYMENT.CAPTURE.COMPLETED` → `paid` (authority = `supplementary_data.related_ids.order_id`, reference = capture `id`, `received` = its `amount`); `PAYMENT.CAPTURE.PENDING`, `CHECKOUT.ORDER.APPROVED` → `pending`; `PAYMENT.CAPTURE.DECLINED` → `failed`; everything else `ignored`. The dispute and refund events are CB-1-j |

## Return and webhook together (PP-1-e)

| # | Rule |
|---|---|
| R1 | The port gains `readonly alsoWebhook?: boolean`, legal only with `settlement: 'return'`; the registry refuses to boot one without `verifyWebhook` (the existing check, widened) |
| R2 | The webhook door (`deposit-webhook.service.ts`) accepts a post when `settlement === 'webhook'` **or** `alsoWebhook`; everything after the signature is unchanged. The browser return of an `alsoWebhook` driver keeps the `return` path (verify and credit), never `showOnly` |
| R3 | Racing is safe: the return's capture and the webhook's `paid` both go through `creditVerified`'s status guard; the loser answers `alreadyPaid`. One spec drives both orders |
| R4 | `start` passes no `webhookUrl` to a `return` driver even with `alsoWebhook` — PayPal's webhook URL is set on the app, not per payment |

## What the panel asks (PP-1-i)

The panel's `PROVIDER_FIELDS` gains `paypal: [{slot: 'merchantId', label:
'clientId'}, {slot: 'secretKey', label: 'secretKey'}, {slot: 'webhookSecret',
label: 'webhookId'}]` (new label `webhookId`). The wizard's details step and
the edit screen show a **charge currency** select, filled from the gateway
answer's `chargeCurrencies` (before the gateway exists: the panel's mirror
`PROVIDER_CURRENCIES.paypal`, same list as P1), default the driver's default;
the rate fields' labels name it ("PayPal charges in EUR — rate: EUR per one
<operating currency>"). A gateway answer with `webhookUrl` shows it read-only
with a copy button and one line: "paste this in your provider's webhook
settings". The help text `gateways.providers.paypal.where` says: create a REST
app at developer.paypal.com › Apps & Credentials (Live), copy the Client ID and
Secret, add a webhook with the URL shown here subscribed to *Payment capture
completed / pending / declined / refunded / reversed* and *Customer dispute
created / updated / resolved*, and paste its Webhook ID; and that a PayPal
account which does not hold the chosen currency must accept those payments
once in PayPal (else they stay pending).
