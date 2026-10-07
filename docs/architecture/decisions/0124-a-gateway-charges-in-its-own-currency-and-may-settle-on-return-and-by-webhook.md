---
id: adr-0124
status: active
updated: 2026-10-06
---

# ADR 0124 — a gateway charges in its own currency, and a driver may settle on return *and* by webhook

- **Status:** accepted (nothing built yet — rows PP-1-a..i)
- **Date:** 2026-10-06
- **Affects units:** billing (`payment-provider.ts`, `deposit-*`, `gateway-admin`), tenant (`tenant_gateway_config`), panel-web (`/gateways`)
- **Decision:** the user's, 2026-10-06 (D-61): PayPal is added; each gateway
  picks its own charge currency; resellers connect with their own REST app keys
- **Amends:** ADR-0051 decision 5 (a webhook gateway is never settled by a browser — still true; its converse is relaxed, point 3)
- **Spec:** [billing/contract.paypal.md](../../domains/billing/contract.paypal.md)

## Context

Every driver so far charges in one fixed currency (`PaymentProvider.chargeCurrency`):
Zarinpal IRR, the international ones USD. PayPal accepts some twenty
currencies, and the user wants each gateway to say which one it charges in.
The pricer has priced any charge currency since F-116-e (a pair of rates
through the USD pivot), so only *where the currency is read from* is fixed.

PayPal's Orders v2 is also the first provider whose payment is **not complete
when the payer finishes**: the payer approves, and the merchant must
`capture`. Until then no money moves, and an uncaptured approval lapses. The
port today makes a driver pick one way to learn a result (`return`,
`webhook`, `in_chat`); a webhook-only PayPal would never capture, and a
return-only PayPal would never hear a dispute, a refund or a capture that
completes days later.

## Decision

1. **The charge currency belongs to the gateway row.** `payment_gateway` and
   `tenant_gateway_config` gain `chargeCurrency` (null = the driver's
   default). A driver declares what it accepts: `chargeCurrencies` (ISO code →
   minor-unit decimals); one that does not declare it accepts exactly its
   `chargeCurrency`/`chargeDecimals`, so the six existing drivers change in
   no behaviour.
2. **A payment records the currency it was charged in**
   (`payment_transaction.chargeCurrency`, backfilled from the provider). From
   then on every reader of "what currency is this payment's
   `chargedAmountMinor` in" reads the row, never the driver or the gateway — a
   gateway edited mid-payment cannot re-explain an open payment.
3. **A `return` driver may also listen for webhooks** (`alsoWebhook: true`).
   Its browser return still verifies (for PayPal, `verify` *is* the capture);
   its signed posts arrive at the same door and pass through the same
   status-guarded settlement (ADR-0028), so the two paths can race and still
   credit once. A `webhook` driver keeps ADR-0051 decision 5 unchanged.
4. **Webhook-URL providers show the URL.** A provider whose webhook URL is
   typed into its own dashboard (Stripe, Airwallex, PayPal) gets it from the
   gateway answer (`webhookUrl`), so the panel shows it with a copy button.
   Until now the panel never showed it.

## Consequences

- A gateway's currency must be one the currency unit rates (`FxRateReader`),
  or the gateway must price from its own `staticRate` — refused otherwise
  (`currency_not_rated`). A reseller who picks EUR needs a EUR rate.
- Changing a verified gateway's currency sends it back to a test transaction,
  as a provider change does (F-104-x).
- Per-gateway currency for an existing driver is now one map entry, not a
  port change. Stripe and Airwallex stay USD until someone asks.

## Rejected

- **A driver per currency** (`paypal_usd`, `paypal_eur`): an enum member per
  currency, and a reseller with two currencies needs two credentials rows.
- **PayPal as `webhook` only, capturing in the webhook door**: the door holds
  no credentials by design (it is public, `verifyWebhook` gets the secret
  only); handing it the merchant's keys widens the one public route.
- **PayPal Partner Referrals ("Connect with PayPal")**: needs PayPal to approve
  the platform as a partner. Can be added later as another way to fill the same
  vault slots (the user's call: own keys first).
