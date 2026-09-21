---
id: tenant
layer: domain
updated: 2026-09-21
---

# Data model — tenant

Source of truth: `txnet-backend/prisma/domains/tenant.prisma` (Postgres schema
`tenant`).

## Tables owned
| Table | Purpose | Tenant-scoped? | Retention |
|---|---|---|---|
| tenant | reseller/platform-owner record; `status`, and `suspendedAt` / `graceEndsAt` / `suspensionCause` (`manual` \| `non_payment`) while suspended (F-018-f, F-019-c); `purgeAfterDays` (default 7, `0` = never) is how long a suspended Grant's configs stay on their panels (F-027-f, ADR-0075) | self | soft-delete |
| tenant_branding | brand name, four image **keys** (light/dark logo, favicon, OG image; CHECK: own tenant, own slot), colours (CHECK `#rrggbb`), support contacts, `socials` JSONB, default language (F-018-h, [contract.branding.md](contract.branding.md)) | yes | with tenant (cascade) |
| tenant_domain | subdomain / custom domain; `verificationStatus` (`pending` \| `verifying` \| `verified` \| `failed`), `verificationToken`, `statusChangedAt`, `lastCheckedAt` / `lastCheck` (what was expected and found), `lastRevalidatedAt`, `revalidatingSince` (F-018-i, [contract.domains.md](contract.domains.md)) | yes | with tenant |
| tenant_feature_package | plans the platform sells to resellers: unique `name`, `monthlyPrice` / `yearlyPrice` (CHECK: positive, at least one), `includedFeatureKeys`, `isActive`; no RLS (F-018-d) | no (catalog of packages) | permanent, deactivated not deleted |
| tenant_subscription | one per reseller: `packageId` (RESTRICT), `currentPeriodEnd`, `renewalWarnedAt` (last unpaid-renewal warning, F-019-c), `graceUntil` (the platform owner's extra time to pay, F-019-g); the period is `tenant.billingModel` (F-018-e) | yes | with tenant |
| tenant_subscription_setting | the platform's one row (`id = 1` CHECK): `trialDays` 0..365, default 14; `suspensionHoldDays` 0..90, default 7 (F-018-f); `renewalGraceDays` 0..30, default 3 (F-019-c); no RLS (F-018-e) | no | permanent |
| tenant_status_history | every status change: `fromStatus`, `toStatus`, `reason`, `actorUserId` (null = the platform); append-only (trigger), FK RESTRICT (F-018-f) | yes | permanent |
| tenant_feature_entitlement | which feature keys are on for a tenant; `package_included` rows are replaced by a subscription `PUT` or a package `apply`, and added to by a package edit (F-018-e, F-018-o) | yes | until revoked/expired |
| tenant_staff_member | reseller's internal team — **membership only**: `invitedByUserId`, `invitedAt`, `joinedAt`, `accessExpiresAt`, `revokedAt`, unique `(tenantId, userId)`. What a member may do is their `identity.user.roleId` (F-018-j, [contract.staff.md](contract.staff.md)) | yes | with tenant (cascade); a removed member is `revokedAt`, never deleted |
| tenant_billing_wallet | a reseller's prepaid balance with the platform (cache, `>= 0`; D-41) | yes | with tenant |
| tenant_billing_transaction | append-only ledger of tenant<->platform charges | yes | permanent |
| tenant_usage_meter | metered usage rollups for pay-as-you-go | yes | permanent |
| tenant_gateway_config / tenant_sms_config | BYO integration settings; the secrets are vault rows (`tenant_sms_config`: one per tenant, no secret column since F-018-a) | yes | with tenant |
| tenant_restriction | brand-level usage caps | yes | until inactive |

## Relationships crossing unit boundaries
| This table | -> | Other unit's table | Why it is allowed |
|---|---|---|---|
| tenant.ownerUserId, tenant_staff_member.userId / .invitedByUserId | -> | identity.user.id | a tenant is owned/staffed by identities. No FK, as `role.tenantId`: the cross-schema SQL is F-041 / F-066-m's, and both columns are written in one place from a user row just read |
| tenant_staff_member.userId | -> | identity.user.roleId -> identity.role | a member's powers are a role **of that tenant** (F-018-n); this table holds no role of its own (D-42 (2)) |
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

`20260919000300_tenant_staff_member` (F-018-j) drops `roleWithinTenant`, the
`TenantStaffRole` enum and `isActive`, adds `invitedByUserId` / `accessExpiresAt`
/ `revokedAt` and the unique `(tenantId, userId)`. The table was never written by
any service, so nothing is backfilled; RLS is untouched (its `tenantId` did not move).

`20260917001700_tenant_subscription_grace` (F-019-g) adds `tenant_subscription.graceUntil` and the audit value
`tenant_subscription_grace`.

`20260917001600_tenant_subscription_renewal` (F-019-c) adds `TenantSuspensionCause` and `tenant.suspensionCause`
(existing suspensions become `manual`), `tenant_subscription.renewalWarnedAt`, and
`renewalGraceDays` with its CHECK.

`20260918000100_tenant_domain_verification` (F-018-i) adds the status `verifying` and the five check columns of
`tenant_domain`.

`20260917001100_tenant_create` (F-018-c) adds the audit values `tenant_create` /
`tenant` and the `tenant.manage` permission — no tenant table changes.
