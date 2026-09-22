---
id: billing
layer: domain
status: active
version: 29
keywords: [wallet, ledger, balance, transfer, coupon, payment gateway, transaction, affiliate, billing-service, /api/billing]
source:
  - txnet-backend/billing-service/src/app/wallet/**
  - txnet-backend/shared-core/src/lib/billing/**
  - txnet-backend/billing-service/src/app/payment/**
  - txnet-backend/billing-service/src/app/request/**
  - txnet-backend/billing-service/src/app/prisma/**
  - txnet-backend/billing-service/src/app/revenue/**
  - txnet-backend/billing-service/src/app/traffic/**
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
owns_tables: [wallet, wallet_transaction, sub_account, wallet_transfer_request, coupon, coupon_service_scope, coupon_allowed_user, coupon_redemption, coupon_tenant, coupon_batch, coupon_gateway, payment_gateway, payment_transaction, payment_reconciliation_log, crypto_payment_detail, affiliate_referral, affiliate_commission, payment_gateway_grant, gateway_settlement_entry, gateway_settlement_payout]
depends_on: [identity, catalog, entitlement, currency, tenant, tenant-context, forward-auth, i18n]
updated: 2026-09-22
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
| [contract.traffic-block.md](contract.traffic-block.md) | buying the bytes a metered Grant may serve: block pricing, the debit, the cursors |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [rules.md](rules.md) | implementing inside this unit |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-22 | contract v29 (F-027-am): **breaking on the default** — `GET /wallet/history` leaves `traffic_consumption` out of a page nobody narrowed, the other eight types by name; `types[]` or a matching search term still answers it in full. The ledger keeps every block's row (ADR-0072 admits no roll-up), so the aggregation is on the read side, and the block floor is F-027-u's. ADR-0072 amended with F-027-q's partial-block rule. Rules: [contract.history.md](contract.history.md). Consumer panel-web: F-027-an, F-027-ao |
| 2026-09-22 | contract v28 (F-027-q): the block purchaser — a metered Grant's bytes are bought at a whole-cent price from `grant.meteredRate` before they are served, and the debit, `purchasedBytes` and `billedBytes` commit in one transaction (ADR-0072). In-process only, no HTTP surface and no wire change. Rules: [contract.traffic-block.md](contract.traffic-block.md). Consumer panel-web: none until F-027-ac |
| 2026-09-21 | contract v27 (F-027-n): metering is its own app, `metering-service` (ADR-0077) — it consumes `network.usage.#` and writes `traffic_raw_log`, `grant.consumedBytes`, holds, quarantines and unattributed usage. No HTTP surface and no wire change here; `consumedBytes` is measured, never charged. Rules: [contract.metering.md](contract.metering.md). Consumer panel-web: none until F-027-ac |
| 2026-09-20 | contract v26 (F-502-o): `CouponView` carries `frozen` — billing's own freeze rule (a counter above zero **or** any redemption row, `frozenBy`), so no caller re-derives it from `usedCount + reservedCount` and offers an edit the service refuses. Additive; the audit snapshot drops it. Rules: [contract.coupon.md](contract.coupon.md). Consumer panel-web: F-502-o |
| 2026-09-20 | contract v25 (F-502-r): `GET /api/billing/gift/grants` — the caller's own Grants, with the variant, the period, the status and the feature keys, paged; never the subscription key or its hash. Its own bucket (120/900s) and the `subscriptionLink` capability. Additive; it is what makes F-502-p's reissue reachable from a row. Rules: [contract.gift.md](contract.gift.md). Consumer panel-web: F-502-s |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
