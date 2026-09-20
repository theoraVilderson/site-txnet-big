---
id: billing
layer: domain
status: active
version: 18
keywords: [wallet, ledger, balance, transfer, coupon, payment gateway, transaction, affiliate, billing-service, /api/billing]
source:
  - txnet-backend/billing-service/src/app/wallet/**
  - txnet-backend/shared-core/src/lib/billing/**
  - txnet-backend/billing-service/src/app/payment/**
  - txnet-backend/billing-service/src/app/request/**
  - txnet-backend/billing-service/src/app/prisma/**
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
updated: 2026-09-20
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
| [contract.webhook.md](contract.webhook.md) | a provider's signed webhook, and a payment that arrived for more or less than asked |
| [contract.history.md](contract.history.md) | the panel's financial page: the wallet ledger and the top-up attempts |
| [contract.verify.md](contract.verify.md) | a payment the gateway met with silence: the retry clock, the flag, manual confirmation |
| [contract.gift.md](contract.gift.md) | the panel's gift-code box: redeeming a wallet-credit coupon |
| [contract.coupon.md](contract.coupon.md) | whose a coupon is, whose users it serves, managing coupons and gift codes |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [rules.md](rules.md) | implementing inside this unit |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-20 | contract v18 (F-066-w3, ADR-0064): `/api/billing/tenants/:tenantId/gateways` — gateway management for the reseller the path names, admitted by `ResellerAccess` and run in that reseller's scope, so the ambient surface's rules apply unchanged. Additive; `/api/billing/gateways` untouched. The gateway rules move out of `contract.md` into `contract.gateways.md`. Consumer panel-web: F-066-w4 |
| 2026-09-18 | contract v17 (F-104-ab), breaking: the in-chat relay moves to `POST /api/internal/billing/deposit/in-chat/{pre-checkout,paid}` — service token only, `{…, platform, senderId, botTenantId}`, admitted only from the payer `start` recorded (`payerChatPlatform`/`payerChatId`, from the gate's new `X-Chat-User-Id`); the gated pair is gone. Consumer bot-app: moved in the same change |
| 2026-09-14 | contract v16 (F-502-a, ADR-0048): a coupon code is unique per tenant; **a platform coupon serves only the tenants `coupon_tenant` names, else the platform owner's users** — a break for resellers' users of existing platform coupons; soft delete, `coupon_batch`, `coupon.manage`. Consumers panel-web, bot-app: no wire change |
| 2026-09-14 | contract v15 (F-092-z, ADR-0044 decision 6): `/api/billing/payments/manual` — list, inquire, confirm a verifying or flagged payment, behind the new `payment.confirm_manual` (`Admin` + `*`), scoped like `gateway.manage`. The gateway is asked first; only silence or `in_bank` lets a person credit `admin_manual`, audited in the crediting transaction. Additive. Consumers: panel-web (F-093-n) |
| 2026-09-14 | contract v14 (F-092-x, ADR-0044): a **verifying** payment — `payment_transaction.verifyAttempts` + `nextVerifyAt`, still `pending`. Silence at the callback or reconciliation schedules the next ask on a 30s…hourly ladder; a settled answer clears it; **the expiry sweep no longer closes a verifying row**, so its coupon holds stay. Additive for every route; consumers tenant, network, ai, engagement, panel-web: nothing reads the columns yet (F-093-l/m) |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
