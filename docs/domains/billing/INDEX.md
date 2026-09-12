---
id: billing
layer: domain
status: active
version: 8
keywords: [wallet, ledger, balance, transfer, coupon, payment gateway, transaction, affiliate, billing-service, /api/billing]
source:
  - txnet-backend/billing-service/src/app/wallet/**
  - txnet-backend/billing-service/src/app/payment/**
  - txnet-backend/billing-service/src/app/request/**
  - txnet-backend/billing-service/src/app/prisma/**
  - txnet-backend/prisma/domains/billing.prisma
  - txnet-backend/prisma/domains/migrations/20260912000100_payment_rate_snapshot_id/**
owns_tables: [wallet, wallet_transaction, sub_account, wallet_transfer_request, coupon, coupon_service_scope, coupon_allowed_user, coupon_redemption, payment_gateway, payment_transaction, payment_reconciliation_log, crypto_payment_detail, affiliate_referral, affiliate_commission]
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
| 2026-09-12 | contract v8 (F-092-k): an abandoned top-up expires — `POST /api/internal/billing/deposit/expire-pending`, this service's **only service-to-service route** (`ServiceOnlyGuard`, `SERVICE_AUTH_TOKEN`), swept by `worker-service`'s `deposit_pending_expiry` tick. The row goes `pending` -> `expired` under the same status guard the callback uses, and its coupon holds are released **`expired`**; the row and its `expiresAt` both stay, because F-092-l inquires it later. New to the unit's edge: a second `CrossTenantPrismaService` reader — the scan is what finds the tenants — and `SERVICE_AUTH_TOKEN` is now required in production. Additive; no existing route or signature changed. Consumers tenant, network, ai, engagement, panel-web: nothing calls it but the job |
| 2026-09-12 | contract v7 (F-092-j): a top-up settles — `GET /api/billing/deposit/callback`, this service's **only public route**: the bank's verify runs outside every transaction, then a status-guarded flip credits the wallet, confirms the holds and writes the outbox event in one (ADR-0028, ADR-0021). Two things are new to the unit's edge, not just to a route: a callback resolves its tenant from the **Host** (ADR-0025), so billing now holds a second, cross-tenant pool; and one route is limited per authority rather than per user. Additive — no existing route or signature changed. Consumers tenant, network, ai, engagement, panel-web: the event has no consumer yet and the redirect's result pages are F-093-f's |
| 2026-09-12 | contract v6 (F-092-i): starting a top-up is built — `POST /api/billing/deposit/start` holds the quote's coupons, writes a `pending` `payment_transaction` with its rate snapshot and expiry, then mints an authority; a zero payable credits the wallet in the same transaction and reaches no gateway. Additive: no existing route or signature changed. Consumers tenant, network, ai, engagement, panel-web — none call it yet; F-092-j settles what it writes |
| 2026-09-12 | contract v5 (F-0606-b, ADR-0019): a payment records **which** rate it was priced at — `exchangeRateSnapshotId`, a FK to `currency_exchange_rate`, frozen with the rate; `priceAtGateway` takes `liveRate` as a `{snapshotId, rate}` pair and returns the id it used. Additive. Consumers tenant, network, ai, engagement, panel-web — none built against the calculator; `DepositQuoteService` is the only caller and still passes `null` |
| 2026-09-11 | contract v4 (F-092-t, D-26): a gateway's vault merchant id is labelled with the gateway row (`gateway:<source>:<id>`), not the provider — every gateway its own account. Consumers tenant, network, ai, engagement — none built against it; no credential of this kind was stored, so nothing migrates |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
