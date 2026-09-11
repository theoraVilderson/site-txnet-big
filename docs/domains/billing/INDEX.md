---
id: billing
layer: domain
status: active
version: 4
keywords: [wallet, ledger, balance, transfer, coupon, payment gateway, transaction, affiliate, billing-service, /api/billing]
source:
  - txnet-backend/billing-service/src/app/wallet/**
  - txnet-backend/billing-service/src/app/payment/**
owns_tables: [wallet, wallet_transaction, sub_account, wallet_transfer_request, coupon, coupon_service_scope, coupon_allowed_user, coupon_redemption, payment_gateway, payment_transaction, payment_reconciliation_log, crypto_payment_detail, affiliate_referral, affiliate_commission]
depends_on: [identity, catalog, currency, tenant, tenant-context, forward-auth, i18n]
updated: 2026-09-11
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
| [contract.deposit.md](contract.deposit.md) | the panel's top-up routes: gateway list and deposit quote |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [rules.md](rules.md) | implementing inside this unit |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-11 | contract v4 (F-092-t, D-26): a gateway's vault merchant id is labelled with the gateway row (`gateway:<source>:<id>`), not the provider — every gateway its own account. Consumers tenant, network, ai, engagement — none built against it; no credential of this kind was stored, so nothing migrates |
| 2026-09-11 | contract v3 (F-092-q, ADR-0038): no tax on a top-up — `taxApplied` and both gateway `taxRatePercent` columns dropped, the price has no tax. Consumers tenant, network, ai, engagement — none built against it |
| 2026-09-11 | contract v2 (F-092-d): a payment names one of two gateway columns; the per-user coupon limit is no longer a DB unique. Consumers tenant, network, ai, engagement — none built against it |
| 2026-09-11 | draft -> active: the wallet credit/debit primitive (F-092-b) is the first built operation |
| 2026-09-04 | Documented from schema during onboarding — no service yet |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
