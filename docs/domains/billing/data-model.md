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
| payment_gateway_grant | who may use whose gateway (ADR-0041). Withdrawn, never deleted | `tenantId` = the **borrowing** tenant | permanent |
| gateway_settlement_entry | what a granted gateway collected, one row per payment, append-only — the debt | `tenantId` = the tenant owed | permanent |
| gateway_settlement_payout | a recorded manual transfer with its proof and its operator — the repayment | `tenantId` = the tenant paid | permanent |

## Relationships crossing unit boundaries
| This table | -> | Other unit's table | Why it is allowed |
|---|---|---|---|
| wallet.ownerUserId | -> | identity.user.id | one wallet per user |
| sub_account.configId | -> | network.config.id | a sub-account funds one VPN config |
| coupon_service_scope.servicePlanId / categoryId | -> | catalog.service_plan / product_category | coupon targeting |
| affiliate_commission.payoutWalletTransactionId | -> | billing.wallet_transaction | payout is itself a ledger entry |
| payment_gateway_grant.tenantGatewayConfigId | -> | tenant.tenant_gateway_config | a grant may lend one reseller's gateway to another (ADR-0041 §2); the owner is unchanged by it |

## Access rules

Planned: no unit outside billing writes these tables; balances/history are read
via a billing service API only.

## Migration notes

`traffic`/high-volume tables live in `network`, not here. Partial unique index
for active coupons and RLS are "section 99" manual SQL — not applied.

**The three settlement tables carry constraints Prisma cannot express**
(`20260912000200_gateway_grant_and_settlement`, F-096-a), and each is a way the
platform could otherwise come to owe the wrong tenant the wrong money:

- a grant names **exactly one** gateway — a CHECK, like `payment_transaction`'s;
- **one live grant per (tenant, gateway)** — two *partial* unique indexes,
  `WHERE "isActive"`, so granting, withdrawing and granting again is ordinary
  while two live rows disagreeing is impossible;
- a withdrawal is **complete** — inactive rows carry when and by whom, live rows
  carry neither;
- **one accrual per payment** — a unique key, because the transaction that
  writes it is reached by a retried callback *and* a reconciliation sweep;
- amounts: an accrual is `>= 0` (a fee can eat a whole payment), a payout `> 0`.

All three are RLS shape A (strict) on the borrowing tenant. **Reading is
isolated; writing is not restricted to the platform owner** — the admin surface
has no tenant of its own yet, the same gap `admin_audit_log` has. Proof:
`payment/gateway-grant-schema.int.spec.ts`.

There is deliberately **no outstanding-balance column**: what is owed is the
accruals minus the payouts, because ADR-0041 §5 says the ledger and not a
remembered total is what says so.
