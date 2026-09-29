---
id: billing
layer: domain
status: active
version: 76
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
  - txnet-backend/prisma/domains/migrations/20260928000900_a_bulk_request_is_applied_once/**
  - txnet-backend/prisma/domains/migrations/20260928001000_a_bulk_job_by_filter/**
  - txnet-backend/prisma/domains/migrations/20260928001100_a_bulk_job_is_audited_and_purged/**
  - txnet-backend/prisma/domains/migrations/20260928002500_every_money_row_records_its_currency/**
  - txnet-backend/prisma/domains/migrations/20260928002700_a_payment_records_both_legs_of_its_rate/**
  - txnet-backend/prisma/domains/migrations/20260928002800_a_currency_change_has_a_reason/**
  - txnet-backend/prisma/domains/migrations/20260928002900_a_currency_change_converts_live_money/**
  - txnet-backend/prisma/domains/migrations/20260928003000_a_gateway_rate_keeps_an_inverse_pair/**
  - txnet-backend/prisma/domains/migrations/20260928003100_a_coupon_redemption_records_its_currency/**
  - txnet-backend/prisma/domains/migrations/20260928003200_a_coupon_applies_only_in_its_own_currency/**
  - txnet-backend/prisma/domains/migrations/20260928003300_a_platform_coupon_serves_no_reseller/**
  - txnet-backend/prisma/domains/migrations/20260929000100_held_money_is_not_spendable/**
  - txnet-backend/prisma/domains/migrations/20260929000500_usage_arrives_as_idempotent_events/**
  - txnet-backend/prisma/domains/migrations/20260929000600_usage_is_rated_and_settled/**
  - txnet-backend/billing-service/src/app/usage/**
owns_tables: [wallet, wallet_hold, wallet_transaction, sub_account, wallet_transfer_request, coupon, coupon_service_scope, coupon_allowed_user, coupon_redemption, coupon_batch, coupon_gateway, payment_gateway, payment_transaction, payment_reconciliation_log, crypto_payment_detail, affiliate_referral, affiliate_commission, payment_gateway_grant, gateway_settlement_entry, gateway_settlement_payout, invoice, currency_change]
depends_on: [identity, governance, catalog, entitlement, currency, tenant, tenant-context, forward-auth, i18n]
updated: 2026-09-29
---

# Billing

**Responsibility (one sentence):** end-user money — the wallet ledger, sub-accounts,
OTP-confirmed transfers, the coupon engine, invoices for catalog purchases, platform-brand
gateways + transactions (card / rial / crypto), and the affiliate commission ledger. **Not:**
tenant<->platform billing (`tenant`), display-currency conversion (`currency`), plan prices (`catalog`).

## Files
| File | Read it when |
|---|---|
| [contract.md](contract.md) | using or changing billing from outside; what a tenant's currency change converts: [contract.currency-change.md](contract.currency-change.md); money held for a promise: [contract.holds.md](contract.holds.md) |
| [contract.gateways.md](contract.gateways.md) | creating, changing or deleting a payment gateway — a tenant's own, or a named reseller's |
| [contract.purchase.md](contract.purchase.md) | buying a catalog product: the invoice, its coupons and discounts with no code, its 30-minute clock, and paying it from the wallet |
| [contract.deposit.md](contract.deposit.md) | one whole top-up: gateway list, quote, start — and the bank's callback that settles it |
| [contract.webhook.md](contract.webhook.md) | a provider's signed webhook, and money that arrived for more, for less, or after the row was settled |
| [contract.history.md](contract.history.md) | the panel's financial page: the wallet ledger and the top-up attempts |
| [contract.verify.md](contract.verify.md) | a payment the gateway met with silence: the retry clock, the flag, manual confirmation |
| [contract.gift.md](contract.gift.md) | the panel's gift-code box, and a user's own Grants, configs, usage and `/sub` link |
| [contract.reseller-grants.md](contract.reseller-grants.md) | a reseller's admin on one of its users' services: reads, config actions, freeze, days, traffic, reset, gift, delete, issue, search by pasted line (F-311); many users' Grants at once, by id or by a filter as a job, and the catalog those forms name (F-311-ab1): [contract.reseller-grants-bulk.md](contract.reseller-grants-bulk.md) (F-311-u, F-311-u2) |
| [contract.coupon.md](contract.coupon.md) | whose a coupon is, whose users it serves, managing coupons and gift codes |
| [contract.revenue.md](contract.revenue.md) | what one reseller sold and what its users paid in, over a period |
| [contract.metering.md](contract.metering.md) | a collection pass becoming usage: what `metering-service` writes, and what it refuses to |
| [contract.traffic-block.md](contract.traffic-block.md) | the money a metered Grant's bytes cost: block pricing, the debit, the cursors, and the remainder given back at close; any other meter's blocks, holds and captures: [contract.usage-rating.md](contract.usage-rating.md) |
| [contract.systems.md](contract.systems.md) | the platform owner's systems routes: registering a panel, and what the systems page reads and acts on |
| [contract.panel-lifecycle.md](contract.panel-lifecycle.md) | editing a registered panel's settings, deleting or archiving one, deleting a panel group |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [rules.md](rules.md) | implementing inside this unit |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-29 | contract v76 (additive, F-118-g, ADR-0105 (5)(6)(11)): rating and settlement — prepaid blocks, postpaid holds captured hourly, before a re-top and at close; reasons `usage_charge` (a sale) and `usage_refund`. No caller sells a non-VPN meter yet. See [contract.usage-rating.md](contract.usage-rating.md) |
| 2026-09-29 | contract v75 (additive, F-118-f, ADR-0105 (5)): usage intake — `usage_event` advances `grant_meter.consumed` once per `(source, idempotencyKey)`, through `recordUsage` in-process or the outbox type `billing.usage.event`. No reporter exists yet; VPN keeps its delta path. See [contract.metering.md](contract.metering.md) |
| 2026-09-29 | contract v74 (additive, F-118-a, ADR-0105 (6)): wallet holds — `hold`/`capture`/`release`, `wallet.heldAmount`; every debit is bounded by the free balance (`cachedBalance - heldAmount`). No hold exists until F-118-b, so no caller's answer changes. See [contract.holds.md](contract.holds.md) |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
