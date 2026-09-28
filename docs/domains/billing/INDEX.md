---
id: billing
layer: domain
status: active
version: 60
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
  - txnet-backend/billing-service/src/app/invoice/**
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
  - txnet-backend/prisma/domains/migrations/20260924001400_deposit_tax_action/**
  - txnet-backend/prisma/domains/migrations/20260925000400_invoice/**
  - txnet-backend/prisma/domains/migrations/20260925000500_product_purchase_reason/**
  - txnet-backend/prisma/domains/migrations/20260925000600_product_refund/**
  - txnet-backend/prisma/domains/migrations/20260925001500_a_discount_without_a_code/**
owns_tables: [wallet, wallet_transaction, sub_account, wallet_transfer_request, coupon, coupon_service_scope, coupon_allowed_user, coupon_redemption, coupon_tenant, coupon_batch, coupon_gateway, payment_gateway, payment_transaction, payment_reconciliation_log, crypto_payment_detail, affiliate_referral, affiliate_commission, payment_gateway_grant, gateway_settlement_entry, gateway_settlement_payout, invoice]
depends_on: [identity, governance, catalog, entitlement, currency, tenant, tenant-context, forward-auth, i18n]
updated: 2026-09-28
---

# Billing

**Responsibility (one sentence):** end-user money — the wallet ledger, sub-accounts,
OTP-confirmed transfers, the coupon engine, invoices for catalog purchases, platform-brand
gateways + transactions (card / rial / crypto), and the affiliate commission ledger. **Not:**
tenant<->platform billing (`tenant`), display-currency conversion (`currency`), plan prices (`catalog`).

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | using or changing billing from outside |
| [contract.gateways.md](contract.gateways.md) | creating, changing or deleting a payment gateway — a tenant's own, or a named reseller's |
| [contract.purchase.md](contract.purchase.md) | buying a catalog product: the invoice, its coupons and discounts with no code, its 30-minute clock, and paying it from the wallet |
| [contract.deposit.md](contract.deposit.md) | one whole top-up: gateway list, quote, start — and the bank's callback that settles it |
| [contract.webhook.md](contract.webhook.md) | a provider's signed webhook, and money that arrived for more, for less, or after the row was settled |
| [contract.history.md](contract.history.md) | the panel's financial page: the wallet ledger and the top-up attempts |
| [contract.verify.md](contract.verify.md) | a payment the gateway met with silence: the retry clock, the flag, manual confirmation |
| [contract.gift.md](contract.gift.md) | the panel's gift-code box, and a user's Grants, configs, usage and `/sub` link — to their owner, or to a reseller's admin for one of its users |
| [contract.coupon.md](contract.coupon.md) | whose a coupon is, whose users it serves, managing coupons and gift codes |
| [contract.revenue.md](contract.revenue.md) | what one reseller sold and what its users paid in, over a period |
| [contract.metering.md](contract.metering.md) | a collection pass becoming usage: what `metering-service` writes, and what it refuses to |
| [contract.traffic-block.md](contract.traffic-block.md) | the money a metered Grant's bytes cost: block pricing, the debit, the cursors, and the remainder given back at close |
| [contract.systems.md](contract.systems.md) | the platform owner's systems routes: registering a panel, and what the systems page reads and acts on |
| [contract.panel-lifecycle.md](contract.panel-lifecycle.md) | editing a registered panel's settings, deleting or archiving one, deleting a panel group |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [rules.md](rules.md) | implementing inside this unit |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-28 | contract v60 (F-311-j): `POST /api/billing/tenants/:tenantId/users/:userId/grants/:grantId/traffic` (`{gb, reason}`) — an admin moves a user's prepaid Grant's Quota by ±GiB, an `admin_grant` `quota_adjustment`; `staffWrite`. Additive. [contract.gift.md](contract.gift.md). Consumers: F-311-w, F-311-y |
| 2026-09-28 | contract v59 (F-311-i): `POST /api/billing/tenants/:tenantId/users/:userId/grants/:grantId/duration` (`{days or endsAt, reason}`) — an admin moves a user's Grant's end, written to `grant_duration_change`; `staffWrite`. Additive. [contract.gift.md](contract.gift.md). Consumers: F-311-w, F-311-y |
| 2026-09-27 | contract v58 (F-311-h): `POST /api/billing/tenants/:tenantId/users/:userId/grants/:grantId/freeze` (`{until?}`) and `…/unfreeze` — an admin freezes a user's Grant, kept and its clock stopped; `staffWrite`. Additive. [contract.gift.md](contract.gift.md). Consumers: F-311-w, F-311-y |
| 2026-09-27 | v57 (F-027-dk): `billing-service` sizes no share and consumes no collection pass — `CeilingAllocatorService`, `HotLoopService`, the hot-loop consumer and the internal `hot-loop/sweep-due` route are deleted; `BlockRequestQueue` unbinds `network.usage.#` from `HOT_LOOP_QUEUE`. `MIN_BLOCK_SECONDS` is in `block-request.ts` |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
