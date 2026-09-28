---
id: billing
layer: domain
updated: 2026-09-28
---

# Open questions — billing

| Date | Question | Blocking? | Current assumption | Exit path |
|---|---|---|---|---|
| 2026-09-04 | `billing-service` is an empty scaffold. Does billing logic land there, or inside `auth-service`/a new service? | yes | ASSUMED(2026-09-04): it fills the existing `billing-service` app, behind ForwardAuth | -> ADR |
| 2026-09-04 | No idempotency-key column on `payment_transaction`. How is double-credit prevented across webhook + reconciliation + admin? | resolved | **Answered 2026-09-09 by ADR-0028**: `@@unique([gatewayId, gatewayTrackingCode])` plus a status guard, both inside the crediting transaction. A gateway with no stable tracking code cannot be integrated without a new decision | -> ADR-0028 + migration |
| 2026-09-04 | Who triggers provisioning (`network.config`) on payment success — synchronous call, outbox, or RabbitMQ? | resolved | **Answered 2026-09-09 by ADR-0021: a transactional outbox.** The producer writes its row and its event in one transaction; a relay delivers them. The "synchronous call until a bus exists" assumption is withdrawn | -> ADR-0021 |
| 2026-09-04 | `wallet_transfer_request.otpCodeHash` — does it reuse `identity` OTP infra or its own? | no | ASSUMED(2026-09-04): reuses `OtpService` with a transfer purpose | -> rules.md |
| 2026-09-11 | `perUserUsageLimit = 0`: legacy read 0 as unlimited; the schema gave it no meaning. What should it mean? | resolved | **Answered 2026-09-11 by the user: 0 is unlimited**, as in legacy | -> contract.md "Coupon validation" + `billing.prisma` comment |
| 2026-09-28 | A platform coupon serving a reseller (`coupon_tenant`) is in the platform's currency; one redeemed by a user whose wallet is in another (a reseller not on `USD`) cannot credit it. Convert at the redemption, or refuse the coupon for that tenant? The same holds for a platform coupon discounting such a tenant's invoice | no | ASSUMED(2026-09-28): the ledger refuses it (`LedgerCurrencyMismatch`); unreachable while every tenant is `USD` | -> F-116-e / F-116-f, with the user |
| 2026-09-28 | A gateway lent (ADR-0041) by a tenant in another currency than the borrower's has its limits, fees, presets and `staticRate` in the lender's currency. F-116-e does not offer it; should those settings be converted at the pair instead? | no | ASSUMED(2026-09-28, F-116-e): not offered (`offeredInCurrency`) until a lender and borrower in two currencies exist | -> contract.deposit.md |
| 2026-09-28 | A currency change divides a gateway's `staticRate`/`minRate`/`maxRate`/`fixedAmountModifier` by the rate at `DECIMAL(18,8)`; an inverse pair (USD -> IRR, a static rate of 1 USD per USD becoming ~0.0000017) keeps 2-3 significant digits (F-116-f) | no | the admin reviews a static-rate gateway after a change; live-rate gateways are unaffected | widen the four columns to `DECIMAL(30,18)` as `payment_transaction.exchangeRateSnapshot` was (F-116-e), if a tenant needs a static inverse rate |
| 2026-09-28 | A late credit that converts to less than one minor unit (a 1,000 IRR refund into a USD wallet) rounds to zero and is refused `LedgerCurrencyMismatch`, so its settlement retries forever (F-116-f) | no | no real top-up or refund is that small | credit the minimum unit, or close it with a note, when a flagged payment shows it |
| 2026-09-28 | A lent gateway's `gateway_settlement_entry` / `payout` rows keep the currency they were written in; after the lender changes currency, "owed" sums two currencies (F-116-f) | no | no tenant has lent a gateway and changed currency | owed per currency, or convert at the change, in the settlement row that first meets it |
