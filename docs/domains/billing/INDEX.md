---
id: billing
layer: domain
status: active
version: 15
keywords: [wallet, ledger, balance, transfer, coupon, payment gateway, transaction, affiliate, billing-service, /api/billing]
source:
  - txnet-backend/billing-service/src/app/wallet/**
  - txnet-backend/billing-service/src/app/payment/**
  - txnet-backend/billing-service/src/app/request/**
  - txnet-backend/billing-service/src/app/prisma/**
  - txnet-backend/prisma/domains/billing.prisma
  - txnet-backend/prisma/domains/migrations/20260912000100_payment_rate_snapshot_id/**
  - txnet-backend/prisma/domains/migrations/20260912000200_gateway_grant_and_settlement/**
  - txnet-backend/prisma/domains/migrations/20260914000100_payment_verify_retry/**
  - txnet-backend/prisma/domains/migrations/20260914000200_payment_verify_flag/**
  - txnet-backend/prisma/domains/migrations/20260914000300_payment_confirm_manual/**
owns_tables: [wallet, wallet_transaction, sub_account, wallet_transfer_request, coupon, coupon_service_scope, coupon_allowed_user, coupon_redemption, payment_gateway, payment_transaction, payment_reconciliation_log, crypto_payment_detail, affiliate_referral, affiliate_commission, payment_gateway_grant, gateway_settlement_entry, gateway_settlement_payout]
depends_on: [identity, catalog, currency, tenant, tenant-context, forward-auth, i18n]
updated: 2026-09-14
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
| [contract.verify.md](contract.verify.md) | a payment the gateway met with silence: the retry clock, the flag, manual confirmation |
| [contract.gift.md](contract.gift.md) | the panel's gift-code box: redeeming a wallet-credit coupon |
| [invariants.md](invariants.md) | writing any code that touches it |
| [data-model.md](data-model.md) | changing storage |
| [rules.md](rules.md) | implementing inside this unit |
| [open-questions.md](open-questions.md) | something is undecided |

## Changelog
| Date | Change |
|---|---|
| 2026-09-14 | contract v15 (F-092-z, ADR-0044 decision 6): `/api/billing/payments/manual` — list, inquire, confirm a verifying or flagged payment, behind the new `payment.confirm_manual` (`Admin` + `*`), scoped like `gateway.manage`. The gateway is asked first; only silence or `in_bank` lets a person credit `admin_manual`, audited in the crediting transaction. Additive. Consumers: panel-web (F-093-n) |
| 2026-09-14 | contract v14 (F-092-x, ADR-0044): a **verifying** payment — `payment_transaction.verifyAttempts` + `nextVerifyAt`, still `pending`. Silence at the callback or reconciliation schedules the next ask on a 30s…hourly ladder; a settled answer clears it; **the expiry sweep no longer closes a verifying row**, so its coupon holds stay. Additive for every route; consumers tenant, network, ai, engagement, panel-web: nothing reads the columns yet (F-093-l/m) |
| 2026-09-12 | contract v13 (F-096-d, ADR-0041 §4): a payment through a granted gateway accrues a debt to the **borrowing** tenant — one `gateway_settlement_entry`, written inside the crediting transaction beside the ledger row and the outbox event, for `amountCredited` net of `feeApplied` and floored at zero. It hangs off the same status guard as the credit, so a retried callback or a reconciliation sweep accrues nothing; the unique key on `paymentTransactionId` is the second line under that. Additive: a payment on a gateway the tenant owns writes nothing new. Consumers tenant, network, ai, engagement, panel-web: nothing reads the ledger yet — F-096-e is the operator surface |
| 2026-09-12 | contract v12 (F-096-c, ADR-0041 §3): a granted gateway is charged with its **owner's** merchant id. `MerchantGatewayRef` may name a grant, and `GatewayMerchant` — the one door every gateway vault read goes through — serves it inside `GrantedVaultAccess.along(...)`: the bind target of the tenant-bound vault connection is overridden for **one call**, after the grant is proved on the application pool in the borrower's own scope and against that gateway, with the owner re-derived and never taken from the caller. The access row lands in the lender's scope tagged `billing:<provider>:grant:<id>`. Additive: a ref with no grant behaves exactly as before. `domains/tenant/contract.vault.md` carries the rule — **its consumers are auth-service and bot-service, and neither changes**: the override lives in billing and the vault itself is untouched |
| 2026-09-12 | contract v11 (F-096-b, ADR-0041 §1/§2/§6): the list and the quote honour a grant — a tenant is offered the gateways granted to it beside its own, and a withdrawn grant, a deactivated gateway or an unverified one removes the row from both at the same moment. The granted row is read on the **cross-tenant** pool bounded to the ids the borrower's own grants named (the lender's row is invisible to the borrower's policy), and the F-092-u vault filter now asks the **owning** tenant's vault, without which every granted gateway would be silently dropped. `selectGateway`/`selectableGateways` gained that pool as a parameter and answer a `GatewayOffer` carrying `grantId` and `ownerTenantId`; `start` writes `grantId` on the payment. Additive for a tenant with no grants — every existing case is unchanged. Consumers tenant, network, ai, engagement, panel-web: the panel's selector needs no change, a granted gateway being an ordinary row in the list |

<!-- INDEX.md is a router. <=40 lines. Never put detail here. -->
