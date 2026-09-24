---
id: billing
layer: domain
status: active
version: 37
keywords: [wallet, ledger, balance, transfer, coupon, payment gateway, transaction, affiliate, billing-service, /api/billing]
source:
  - txnet-backend/billing-service/src/app/wallet/**
  - txnet-backend/shared-core/src/lib/billing/**
  - txnet-backend/billing-service/src/app/payment/**
  - txnet-backend/billing-service/src/app/request/**
  - txnet-backend/billing-service/src/app/prisma/**
  - txnet-backend/billing-service/src/app/revenue/**
  - txnet-backend/billing-service/src/app/traffic/**
  - txnet-backend/billing-service/src/app/systems/**
  - txnet-backend/metering-service/src/app/**
  - txnet-backend/prisma/domains/billing.prisma
  - txnet-backend/prisma/domains/migrations/20260912000100_payment_rate_snapshot_id/**
  - txnet-backend/prisma/domains/migrations/20260912000200_gateway_grant_and_settlement/**
  - txnet-backend/prisma/domains/migrations/20260914000100_payment_verify_retry/**
  - txnet-backend/prisma/domains/migrations/20260914000200_payment_verify_flag/**
  - txnet-backend/prisma/domains/migrations/20260914000300_payment_confirm_manual/**
  - txnet-backend/prisma/domains/migrations/20260914000400_claim_expired_coupon_redemptions/**
  - txnet-backend/prisma/domains/migrations/20260914000900_coupon_management_schema/**
  - txnet-backend/prisma/domains/migrations/20260914001000_coupon_scope_in_functions/**
  - txnet-backend/prisma/domains/migrations/20260914001100_coupon_limits/**
  - txnet-backend/prisma/domains/migrations/20260914001200_coupon_limit_gates/**
  - txnet-backend/prisma/domains/migrations/20260914001300_coupon_admin_actions/**
  - txnet-backend/prisma/domains/migrations/20260914001400_coupon_batch_actions/**
  - txnet-backend/prisma/domains/migrations/20260916000200_payment_d32_providers_and_receipt/**
  - txnet-backend/prisma/domains/migrations/20260917000200_gateway_release/**
  - txnet-backend/prisma/domains/migrations/20260917001000_payment_billing_tenant/**
  - txnet-backend/prisma/domains/migrations/20260918000300_payment_in_chat_payer/**
  - txnet-backend/prisma/domains/migrations/20260922000200_traffic_refund_reason/**
  - txnet-backend/prisma/domains/migrations/20260924001300_tax_on_top_up_returns/**
owns_tables: [wallet, wallet_transaction, sub_account, wallet_transfer_request, coupon, coupon_service_scope, coupon_allowed_user, coupon_redemption, coupon_tenant, coupon_batch, coupon_gateway, payment_gateway, payment_transaction, payment_reconciliation_log, crypto_payment_detail, affiliate_referral, affiliate_commission, payment_gateway_grant, gateway_settlement_entry, gateway_settlement_payout]
depends_on: [identity, catalog, entitlement, currency, tenant, tenant-context, forward-auth, i18n]
updated: 2026-09-24
---

# Billing

**Responsibility (one sentence):** end-user money — the wallet ledger,
Config-scoped sub-accounts, OTP-confirmed wallet transfers, the coupon engine,
platform-brand payment gateways + transactions (card / rial / crypto), and the
affiliate commission ledger.
**Explicitly NOT responsible for:** tenant<->platform billing (`tenant`),
display-currency conversion (`currency`), plan prices (`catalog`).

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | using or changing billing from outside |
| [contract.gateways.md](contract.gateways.md) | creating, changing or deleting a payment gateway — a tenant's own, or a named reseller's |
| [contract.deposit.md](contract.deposit.md) | one whole top-up: gateway list, quote, start — and the bank's callback that settles it |
| [contract.webhook.md](contract.webhook.md) | a provider's signed webhook, and money that arrived for more, for less, or after the row was settled |
| [contract.history.md](contract.history.md) | the panel's financial page: the wallet ledger and the top-up attempts |
| [contract.verify.md](contract.verify.md) | a payment the gateway met with silence: the retry clock, the flag, manual confirmation |
| [contract.gift.md](contract.gift.md) | the panel's gift-code box: redeeming a wallet-credit coupon |
| [contract.coupon.md](contract.coupon.md) | whose a coupon is, whose users it serves, managing coupons and gift codes |
| [contract.revenue.md](contract.revenue.md) | what one reseller sold and what its users paid in, over a period |
| [contract.metering.md](contract.metering.md) | a collection pass becoming usage: what `metering-service` writes, and what it refuses to |
| [contract.traffic-block.md](contract.traffic-block.md) | the money a metered Grant's bytes cost: block pricing, the debit, the cursors, and the remainder given back at close |
| [contract.systems.md](contract.systems.md) | the platform owner's systems routes: registering a panel, and what the systems page reads and acts on |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [rules.md](rules.md) | implementing inside this unit |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-24 | contract v37 (F-104-af): a top-up is taxed again (ADR-0076, reversing v3's "no tax") — `priceAtGateway` adds `tax` on the basis, half-up; the quote and start answers gain `tax` + `taxRatePercent`, and `payable` includes it. Additive fields; with no rate set `tax` is `0.00` and nothing moves. Consumers: panel-web F-104-ah; bot-service `top-up.flow.ts` shows fee and payable with no tax line (lags, no row yet) |
| 2026-09-24 | contract v36 (F-027-au): new `PUT /systems/panels/:id/credentials` — rotates a panel's login in the vault; on a `pending` panel clears its last test (not after `rate_limited`) so the next tick re-tests; an accepted one is rotated only; refused is 409 `panel_refused`. [contract.systems.md](contract.systems.md) |
| 2026-09-24 | contract v35 (F-027-at): new `GET /systems/holds`, `POST /systems/holds/:id/release` (202; queued to `metering-service` through the outbox as `network.usage.release`, billed there through the meter) and `POST /systems/holds/:id/write-off` (never charged, once, note required). Additive, no break; `contract.systems.md`, `contract.metering.md`. Consumer panel-web: F-027-ad |
| 2026-09-24 | contract v34 (F-027-as): new `GET /systems/panels` (review, health, request budget), `GET /systems/panels/:id/capabilities`, `GET /systems/drift-events`, `POST /systems/drift-events/:id/acknowledge` — resumes a halted panel on the next pass. Additive, no break; `contract.systems.md`. Consumer panel-web: F-027-ad |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
