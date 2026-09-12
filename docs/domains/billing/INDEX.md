---
id: billing
layer: domain
status: active
version: 6
keywords: [wallet, ledger, balance, transfer, coupon, payment gateway, transaction, affiliate, billing-service, /api/billing]
source:
  - txnet-backend/billing-service/src/app/wallet/**
  - txnet-backend/billing-service/src/app/payment/**
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
| [contract.deposit.md](contract.deposit.md) | the panel's top-up routes: gateway list, deposit quote, starting the payment |
| [contract.history.md](contract.history.md) | the panel's financial page: the wallet ledger and the top-up attempts |
| [contract.gift.md](contract.gift.md) | the panel's gift-code box: redeeming a wallet-credit coupon |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [rules.md](rules.md) | implementing inside this unit |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-12 | contract v6 (F-092-i): starting a top-up is built — `POST /api/billing/deposit/start` holds the quote's coupons, writes a `pending` `payment_transaction` with its rate snapshot and expiry, then mints an authority; a zero payable credits the wallet in the same transaction and reaches no gateway. Additive: no existing route or signature changed. Consumers tenant, network, ai, engagement, panel-web — none call it yet; F-092-j settles what it writes |
| 2026-09-12 | contract v5 (F-0606-b, ADR-0019): a payment records **which** rate it was priced at — `exchangeRateSnapshotId`, a FK to `currency_exchange_rate`, frozen with the rate; `priceAtGateway` takes `liveRate` as a `{snapshotId, rate}` pair and returns the id it used. Additive. Consumers tenant, network, ai, engagement, panel-web — none built against the calculator; `DepositQuoteService` is the only caller and still passes `null` |
| 2026-09-11 | contract v4 (F-092-t, D-26): a gateway's vault merchant id is labelled with the gateway row (`gateway:<source>:<id>`), not the provider — every gateway its own account. Consumers tenant, network, ai, engagement — none built against it; no credential of this kind was stored, so nothing migrates |
| 2026-09-11 | contract v3 (F-092-q, ADR-0038): no tax on a top-up — `taxApplied` and both gateway `taxRatePercent` columns dropped, the price has no tax. Consumers tenant, network, ai, engagement — none built against it |
| 2026-09-11 | contract v2 (F-092-d): a payment names one of two gateway columns; the per-user coupon limit is no longer a DB unique. Consumers tenant, network, ai, engagement — none built against it |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
