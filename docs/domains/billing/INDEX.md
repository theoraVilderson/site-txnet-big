---
id: billing
layer: domain
status: active
version: 22
keywords: [wallet, ledger, balance, transfer, coupon, payment gateway, transaction, affiliate, billing-service, /api/billing]
source:
  - txnet-backend/billing-service/src/app/wallet/**
  - txnet-backend/shared-core/src/lib/billing/**
  - txnet-backend/billing-service/src/app/payment/**
  - txnet-backend/billing-service/src/app/request/**
  - txnet-backend/billing-service/src/app/prisma/**
  - txnet-backend/billing-service/src/app/revenue/**
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
| [contract.webhook.md](contract.webhook.md) | a provider's signed webhook, and money that arrived for more, for less, or after the row was settled |
| [contract.history.md](contract.history.md) | the panel's financial page: the wallet ledger and the top-up attempts |
| [contract.verify.md](contract.verify.md) | a payment the gateway met with silence: the retry clock, the flag, manual confirmation |
| [contract.gift.md](contract.gift.md) | the panel's gift-code box: redeeming a wallet-credit coupon |
| [contract.coupon.md](contract.coupon.md) | whose a coupon is, whose users it serves, managing coupons and gift codes |
| [contract.revenue.md](contract.revenue.md) | what one reseller sold and what its users paid in, over a period |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [rules.md](rules.md) | implementing inside this unit |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-20 | contract v22 (F-104-t): deleting a gateway switches it off first and counts the open payments again before revoking any secret — a top-up started in that window used to be stranded by the revoked `webhook_secret`. A delete raced this way is refused `gateway_has_open_payments` with the gateway left deactivated. Rules: [contract.gateways.md](contract.gateways.md). Consumer panel-web: none — the same refusal reason it already shows |
| 2026-09-20 | contract v21 (F-104-s, ADR-0068): a signed `paid` for an **already settled** row is no longer dropped — one provider invoice holds several payments, so the arrival becomes a payment of its own, credited net of the gateway's cut and carrying the transfer's reference as its code; what cannot be valued is a `flagged_mismatch` log row on the invoice. Additive, no wire change. Rules: [contract.webhook.md](contract.webhook.md). Consumer panel-web: none — a follow-on reads as an ordinary credit on the financial page |
| 2026-09-20 | contract v20 (F-093-q): `POST /api/billing/deposit/:paymentId/abandon` — the payer's own unpaid, never-approved in-chat payment is closed `failed` `abandoned` and its coupon holds released `cancelled`, instead of waiting out `PAYMENT_PENDING_TTL_SEC`. Additive, 200 verdict. A payment pre-checkout approved is refused: ADR-0047 decision 2 keeps its holds. Rules: [contract.webhook.md](contract.webhook.md). Consumer panel-web: the Mini App top-up page, in the same change |
| 2026-09-20 | contract v19 (F-311-b, ADR-0067): `GET /api/billing/tenants/:tenantId/revenue` — a named reseller's own sales and top-ups over a period, from the wallet and payment ledgers, admitted by `ResellerAccess` and run in that reseller's scope. Two figures, gross, never `settlement`'s number (F-096-e). Additive; `sales` is `0.00` until `entitlement` writes a `traffic_consumption` row. Rules: [contract.revenue.md](contract.revenue.md). Consumer bot-app: F-311-c |
| 2026-09-20 | contract v18 (F-066-w3, ADR-0064): `/api/billing/tenants/:tenantId/gateways` — gateway management for the reseller the path names, admitted by `ResellerAccess` and run in that reseller's scope, so the ambient surface's rules apply unchanged. Additive; `/api/billing/gateways` untouched. The gateway rules move out of `contract.md` into `contract.gateways.md`. Consumer panel-web: F-066-w4 |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
