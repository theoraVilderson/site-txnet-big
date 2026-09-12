---
id: billing
layer: domain
status: active
version: 10
keywords: [wallet, ledger, balance, transfer, coupon, payment gateway, transaction, affiliate, billing-service, /api/billing]
source:
  - txnet-backend/billing-service/src/app/wallet/**
  - txnet-backend/billing-service/src/app/payment/**
  - txnet-backend/billing-service/src/app/request/**
  - txnet-backend/billing-service/src/app/prisma/**
  - txnet-backend/prisma/domains/billing.prisma
  - txnet-backend/prisma/domains/migrations/20260912000100_payment_rate_snapshot_id/**
  - txnet-backend/prisma/domains/migrations/20260912000200_gateway_grant_and_settlement/**
owns_tables: [wallet, wallet_transaction, sub_account, wallet_transfer_request, coupon, coupon_service_scope, coupon_allowed_user, coupon_redemption, payment_gateway, payment_transaction, payment_reconciliation_log, crypto_payment_detail, affiliate_referral, affiliate_commission, payment_gateway_grant, gateway_settlement_entry, gateway_settlement_payout]
depends_on: [identity, catalog, currency, tenant, tenant-context, forward-auth, i18n]
updated: 2026-09-12
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
| [contract.deposit.md](contract.deposit.md) | one whole top-up: gateway list, quote, start — and the bank's callback that settles it |
| [contract.history.md](contract.history.md) | the panel's financial page: the wallet ledger and the top-up attempts |
| [contract.gift.md](contract.gift.md) | the panel's gift-code box: redeeming a wallet-credit coupon |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [rules.md](rules.md) | implementing inside this unit |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-12 | contract v10 (F-096-a, ADR-0041): the schema a granted gateway needs — `payment_gateway_grant` (who may use whose gateway, withdrawn and never deleted), `payment_transaction.grantId`, `gateway_settlement_entry` (the debt, one row per payment) and `gateway_settlement_payout` (a recorded manual transfer with its proof). **Schema and constraints only; no service reads any of it** — F-096-b onwards do. The constraints are the content: exactly one gateway per grant, one *live* grant per (tenant, gateway) by partial index, a complete withdrawal, one accrual per payment, and RLS shape A on the **borrowing** tenant. Additive — the new `grantId` column is nullable and NULL is the ordinary case. Consumers tenant, network, ai, engagement, panel-web: nothing changes for them yet |
| 2026-09-12 | contract v9 (F-092-l): reconciliation — `POST /api/internal/billing/deposit/reconcile` asks the gateway about `expired` and past-clock `pending` payments, credits what it confirms through F-092-j's guarded path as `reconciliation_auto`, and records an amount it reports differently as `flagged_mismatch`. **It never closes a payment and never reverses one** (invariant 9), and an answer the gateway could not give writes no log row, so the next run asks again. The credit itself moved into `DepositSettlementService`, shared with the callback — behaviour unchanged, proven by that route's own 12 specs. Additive; no existing route or signature changed. Consumers tenant, network, ai, engagement, panel-web: nothing surfaces a flagged mismatch yet |
| 2026-09-12 | contract v8 (F-092-k): an abandoned top-up expires — `POST /api/internal/billing/deposit/expire-pending`, this service's **only service-to-service route** (`ServiceOnlyGuard`, `SERVICE_AUTH_TOKEN`), swept by `worker-service`'s `deposit_pending_expiry` tick. The row goes `pending` -> `expired` under the same status guard the callback uses, and its coupon holds are released **`expired`**; the row and its `expiresAt` both stay, because F-092-l inquires it later. New to the unit's edge: a second `CrossTenantPrismaService` reader — the scan is what finds the tenants — and `SERVICE_AUTH_TOKEN` is now required in production. Additive; no existing route or signature changed. Consumers tenant, network, ai, engagement, panel-web: nothing calls it but the job |
| 2026-09-12 | contract v7 (F-092-j): a top-up settles — `GET /api/billing/deposit/callback`, this service's **only public route**: the bank's verify runs outside every transaction, then a status-guarded flip credits the wallet, confirms the holds and writes the outbox event in one (ADR-0028, ADR-0021). Two things are new to the unit's edge, not just to a route: a callback resolves its tenant from the **Host** (ADR-0025), so billing now holds a second, cross-tenant pool; and one route is limited per authority rather than per user. Additive — no existing route or signature changed. Consumers tenant, network, ai, engagement, panel-web: the event has no consumer yet and the redirect's result pages are F-093-f's |
| 2026-09-12 | contract v6 (F-092-i): starting a top-up is built — `POST /api/billing/deposit/start` holds the quote's coupons, writes a `pending` `payment_transaction` with its rate snapshot and expiry, then mints an authority; a zero payable credits the wallet in the same transaction and reaches no gateway. Additive: no existing route or signature changed. Consumers tenant, network, ai, engagement, panel-web — none call it yet; F-092-j settles what it writes |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
