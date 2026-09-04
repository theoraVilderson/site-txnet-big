---
id: billing
layer: domain
updated: 2026-09-04
---

# Data model — billing

Source of truth: `txnet-backend/prisma/domains/billing.prisma` (Postgres schema
`billing`).

## Tables owned
| Table | Purpose | Tenant-scoped? | Retention |
|---|---|---|---|
| wallet | user balance cache + optimistic version | via owner user | permanent |
| wallet_transaction | append-only money ledger (`balanceAfter` per row) | denormalized `tenantId` | permanent |
| sub_account | Config-scoped shared spending pocket (byte cap) | via parent wallet | with config |
| wallet_transfer_request | OTP-confirmed user->user transfer state machine | — | permanent (audit) |
| coupon + coupon_service_scope + coupon_allowed_user + coupon_redemption | coupon engine (reserve/confirm) | `coupon.tenantId` nullable (null = platform-wide) | permanent |
| payment_gateway | platform-brand gateway config (card/rial/crypto) | platform-owner only | permanent |
| payment_transaction | payment intent + status + confirmation source | denormalized `tenantId` | permanent |
| payment_reconciliation_log | inquiry-API cross-check results | via payment | permanent |
| crypto_payment_detail | asset/network/address/confs/rate snapshot | via payment | permanent |
| affiliate_referral + affiliate_commission | affiliate payout ledger | — | permanent |

## Relationships crossing unit boundaries
| This table | -> | Other unit's table | Why it is allowed |
|---|---|---|---|
| wallet.ownerUserId | -> | identity.user.id | one wallet per user |
| sub_account.configId | -> | network.config.id | a sub-account funds one VPN config |
| coupon_service_scope.servicePlanId / categoryId | -> | catalog.service_plan / product_category | coupon targeting |
| affiliate_commission.payoutWalletTransactionId | -> | billing.wallet_transaction | payout is itself a ledger entry |

## Access rules

Planned: no unit outside billing writes these tables; balances/history are read
via a billing service API only.

## Migration notes

`traffic`/high-volume tables live in `network`, not here. Partial unique index
for active coupons and RLS are "section 99" manual SQL — not applied.
