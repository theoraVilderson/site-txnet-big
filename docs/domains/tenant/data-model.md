---
id: tenant
layer: domain
updated: 2026-09-17
---

# Data model — tenant

Source of truth: `txnet-backend/prisma/domains/tenant.prisma` (Postgres schema
`tenant`).

## Tables owned
| Table | Purpose | Tenant-scoped? | Retention |
|---|---|---|---|
| tenant | reseller/platform-owner record; `status`, and `suspendedAt` / `graceEndsAt` while suspended (F-018-f) | self | soft-delete |
| tenant_branding | logo, colours, support contacts, default language | yes | with tenant (cascade) |
| tenant_domain | subdomain / custom domain + verification | yes | with tenant |
| tenant_feature_package | plans the platform sells to resellers: unique `name`, `monthlyPrice` / `yearlyPrice` (CHECK: positive, at least one), `includedFeatureKeys`, `isActive`; no RLS (F-018-d) | no (catalog of packages) | permanent, deactivated not deleted |
| tenant_subscription | one per reseller: `packageId` (RESTRICT) and `currentPeriodEnd`; the period is `tenant.billingModel` (F-018-e) | yes | with tenant |
| tenant_subscription_setting | the platform's one row (`id = 1` CHECK): `trialDays` 0..365, default 14; `suspensionHoldDays` 0..90, default 7 (F-018-f); no RLS (F-018-e) | no | permanent |
| tenant_status_history | every status change: `fromStatus`, `toStatus`, `reason`, `actorUserId` (null = the platform); append-only (trigger), FK RESTRICT (F-018-f) | yes | permanent |
| tenant_feature_entitlement | which feature keys are on for a tenant; `package_included` rows are replaced by a subscription `PUT` or a package `apply`, and added to by a package edit (F-018-e, F-018-o) | yes | until revoked/expired |
| tenant_staff_member | reseller's internal team (own RBAC, separate from identity.role) | yes | — |
| tenant_billing_wallet | a reseller's prepaid balance with the platform (cache, `>= 0`; D-41) | yes | with tenant |
| tenant_billing_transaction | append-only ledger of tenant<->platform charges | yes | permanent |
| tenant_usage_meter | metered usage rollups for pay-as-you-go | yes | permanent |
| tenant_gateway_config / tenant_sms_config | BYO integration settings; the secrets are vault rows (`tenant_sms_config`: one per tenant, no secret column since F-018-a) | yes | with tenant |
| tenant_restriction | brand-level usage caps | yes | until inactive |

## Relationships crossing unit boundaries
| This table | -> | Other unit's table | Why it is allowed |
|---|---|---|---|
| tenant.ownerUserId, tenant_staff_member.userId | -> | identity.user.id | a tenant is owned/staffed by identities |
| tenant_gateway_config.providerName / gatewayCategory | -> | billing enums | reuse of the payment-provider taxonomy |

## Access rules

Planned: only a tenant-admin service writes these; end-user-facing services read
branding/entitlements through a resolver, never the raw tables.

## Migration notes

`platform_owner` uniqueness, partial unique indexes on domains, and RLS are
"section 99" manual SQL — not applied.

`20260917000900_tenant_billing_wallet` (F-019-a) adds what Prisma cannot model:
non-negative `cachedBalance` / `balanceAfter`, positive `amount`, and a partial
unique `(reasonType, referenceId)` on `tenant_billing_transaction`.

`20260917001300_tenant_subscription` (F-018-e) adds both subscription tables, strict
RLS on `tenant_subscription`, the settings row and its CHECKs.

`20260917001500_tenant_status` (F-018-f) adds the two tenant columns, `tenant_status_history`
with strict RLS and its append-only trigger, `suspensionHoldDays` and its CHECK,
and the `tenant_status_changed` NOTIFY trigger on `tenant.tenant`.

`20260917001100_tenant_create` (F-018-c) adds the audit values `tenant_create` /
`tenant` and the `tenant.manage` permission — no tenant table changes.
